/**
 * Postgres pool lifecycle — Phase 1 of PLAN-agent-ts.
 *
 * Mirrors `services/agent-py/src/agent_py/db.py`. Uses the `postgres`
 * driver (porsager/postgres) for two reasons:
 *
 *   1. `FOR UPDATE SKIP LOCKED` semantics. The existing TS
 *      `lib/server/agent/jobs.ts` goes through Supabase's REST
 *      proxy which can't open a real transaction and so loses the
 *      lock guarantee that prevents two workers from claiming the
 *      same row. The Python worker uses asyncpg + direct Postgres
 *      for the same reason; we match.
 *
 *   2. Smaller dependency surface. The Supabase JS client + the
 *      codegen `Database` types bring in a lot for what amounts to
 *      a handful of SQL statements.
 *
 *   See [Follow-up A] in `docs/PLAN-agent-ts.md` for the rationale
 *   on diverging from the plan's "reuse existing TS modules" line.
 *
 * `SUPABASE_DB_URL` must point at the *direct* Postgres connection
 * (`db.<project>.supabase.co:5432`), NOT the pooler — same constraint
 * as agent-py.
 */

import postgres from "postgres"

import { getEnv } from "./env"

export type Sql = ReturnType<typeof postgres>

let _pool: Sql | null = null

/** Open the connection pool. Called from the lifespan hook on app
 *  startup. With an empty DSN this no-ops so dev / tests that don't
 *  care about the DB can still boot. */
export function initPool(dsn: string | null = null): void {
  const url = (dsn ?? getEnv().SUPABASE_DB_URL).trim()
  if (!url) {
    return
  }
  if (_pool) {
    // Idempotent — calling twice is a programmer error but not
    // catastrophic. Reuse the existing pool.
    return
  }
  _pool = postgres(url, {
    // Conservative defaults — the worker only runs a handful of
    // queries per tick.
    max: 10,
    idle_timeout: 30,
    // Don't let one bad transaction lock up the pool — postgres
    // driver returns errors and lets the caller decide.
    onnotice: () => {},
  })
}

/** Return the open pool. Throws if `initPool` wasn't called or
 *  succeeded — the route / poller should guard with `hasPool()`. */
export function getPool(): Sql {
  if (!_pool) {
    throw new Error("DB pool not initialised — call initPool() on app startup.")
  }
  return _pool
}

/** Cheap check the route / poller uses to decide whether to bother
 *  attempting a DB-backed code path. */
export function hasPool(): boolean {
  return _pool !== null
}

/** Close the pool on graceful shutdown. */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end({ timeout: 5 })
    _pool = null
  }
}

/** Test helper — drop the singleton without trying to close it.
 *  Used by tests that mocked the DB and never actually opened one. */
export function resetPoolForTest(): void {
  _pool = null
}
