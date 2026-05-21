"use client"
import "client-only"

/**
 * Background sync queue. Mirrors local Zustand mutations to Supabase when
 * the user is signed in and online.
 *
 * Design notes:
 * - The queue is process-local but persisted to `localStorage` under
 *   `hummingbird-sync-queue`, so pending writes survive reloads.
 * - It pauses entirely when the user is signed out, Supabase isn't
 *   configured, or the browser is offline. The producer side keeps
 *   enqueueing — replay happens once the gate opens.
 * - Per-op exponential backoff caps at 60s. Permanent failures (4xx that
 *   aren't 401/408/429) are dropped so a malformed op can't wedge the queue.
 * - Ops are tagged with `clientOpId` (a UUID assigned at enqueue) for
 *   logging. The DB row PK is whatever the handler picks (typically the
 *   entity id from the Zustand store).
 */

import type { AppSupabaseClient } from "@/client/supabase/client"
import { uuid } from "@/shared/uuid"

const STORAGE_KEY = "hummingbird-sync-queue"
const MAX_BACKOFF_MS = 60_000
const BASE_BACKOFF_MS = 500

/** Type of cloud mutation. The handler is determined by `op.target`. */
export type SyncOp =
  | {
      kind: "upsert"
      target: SyncTarget
      clientOpId: string
      /** Row to send to .upsert(). user_id MUST be present. */
      row: Record<string, unknown>
      attempts?: number
    }
  | {
      kind: "delete"
      target: SyncTarget
      clientOpId: string
      /** Row identifier. Most tables key on `id`. */
      where: { column: string; value: string }
      attempts?: number
    }
  | {
      kind: "deleteMany"
      target: SyncTarget
      clientOpId: string
      /** Used for cascades where Postgres's ON DELETE doesn't quite match. */
      filters: Array<{ column: string; value: string | string[] }>
      attempts?: number
    }

export type SyncTarget =
  | "workspaces"
  | "documents"
  | "conversations"
  | "messages"
  | "files"
  | "resources"
  | "conversation_files"
  | "artifacts"
  | "notes"
  | "mcp_servers"
  | "mcp_resources"
  | "mcp_resource_bindings"
  | "conversation_mcp_resources"

interface QueueState {
  ops: SyncOp[]
  /** Wall-clock ms timestamp at which the next attempt is allowed. */
  notBefore: number
}

// In-memory state. Persists to localStorage on every change.
let state: QueueState = { ops: [], notBefore: 0 }
let flushing = false
let scheduled: ReturnType<typeof setTimeout> | null = null

let client: AppSupabaseClient | null = null
let userId: string | null = null
let online = typeof navigator !== "undefined" ? navigator.onLine : true
let initialized = false

// -- persistence -------------------------------------------------------------

function load(): void {
  if (typeof window === "undefined") return
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<QueueState>
    if (Array.isArray(parsed.ops)) state.ops = parsed.ops as SyncOp[]
    if (typeof parsed.notBefore === "number") state.notBefore = parsed.notBefore
  } catch {
    // Corrupt queue — discard rather than blocking forever.
    state = { ops: [], notBefore: 0 }
  }
}

function persist(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage full / disabled — accept that pending ops won't survive
    // a reload. Don't crash.
  }
}

// -- gating ------------------------------------------------------------------

function gateOpen(): boolean {
  return !!client && !!userId && online && state.ops.length > 0
}

function scheduleFlush(delayMs = 0): void {
  if (scheduled !== null) {
    clearTimeout(scheduled)
    scheduled = null
  }
  if (!gateOpen()) return
  const wait = Math.max(delayMs, state.notBefore - Date.now(), 0)
  scheduled = setTimeout(() => {
    scheduled = null
    void flush()
  }, wait)
}

// -- flush loop --------------------------------------------------------------

async function flush(): Promise<void> {
  if (flushing) return
  if (!gateOpen()) return
  flushing = true
  try {
    while (state.ops.length > 0 && gateOpen()) {
      const op = state.ops[0]
      const result = await runOp(op)
      if (result === "ok") {
        state.ops.shift()
        state.notBefore = 0
        persist()
        continue
      }
      if (result === "drop") {
        // 4xx that won't be fixed by retrying. Surface to console; don't
        // wedge the queue.
        console.warn("[sync] dropping un-retryable op", op)
        state.ops.shift()
        state.notBefore = 0
        persist()
        continue
      }
      // retry
      const attempts = (op.attempts ?? 0) + 1
      const next: SyncOp = { ...op, attempts } as SyncOp
      state.ops[0] = next
      const backoff = Math.min(
        BASE_BACKOFF_MS * 2 ** (attempts - 1),
        MAX_BACKOFF_MS
      )
      state.notBefore = Date.now() + backoff
      persist()
      // Reschedule and bail; we'll come back when notBefore passes.
      scheduleFlush(backoff)
      return
    }
  } finally {
    flushing = false
  }
}

type OpResult = "ok" | "retry" | "drop"

async function runOp(op: SyncOp): Promise<OpResult> {
  if (!client || !userId) return "retry"
  try {
    if (op.kind === "upsert") {
      const row = { ...op.row, user_id: userId }
      const { error } = await client
        .from(op.target)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .upsert(row as any, { onConflict: "id" })
      if (error) return classify(error.code)
      return "ok"
    }
    if (op.kind === "delete") {
      const { error } = await client
        .from(op.target)
        .delete()
        .eq(op.where.column, op.where.value)
      if (error) return classify(error.code)
      return "ok"
    }
    if (op.kind === "deleteMany") {
      let q = client.from(op.target).delete()
      for (const f of op.filters) {
        q = Array.isArray(f.value) ? q.in(f.column, f.value) : q.eq(f.column, f.value)
      }
      const { error } = await q
      if (error) return classify(error.code)
      return "ok"
    }
  } catch (err) {
    // Network or unexpected — retry.
    console.warn("[sync] op threw", err)
    return "retry"
  }
  return "retry"
}

function classify(code: string | undefined): OpResult {
  // PostgrestError.code is a Postgres SQLSTATE for backend errors, or an
  // empty string for transport errors. Heuristics:
  //  - 23xxx integrity_constraint_violation → drop (malformed write)
  //  - 22xxx data_exception → drop
  //  - 42xxx syntax / undefined object → drop (programmer error)
  //  - 4xx string codes from postgrest (PGRST200 etc.) starting with PGRST
  //    fall through to drop too.
  //  - Anything else / empty → assume transient, retry.
  if (!code) return "retry"
  if (code.startsWith("23")) return "drop"
  if (code.startsWith("22")) return "drop"
  if (code.startsWith("42")) return "drop"
  if (code.startsWith("PGRST")) return "drop"
  return "retry"
}

// -- public API --------------------------------------------------------------

export function ensureInit(): void {
  if (initialized) return
  initialized = true
  if (typeof window === "undefined") return
  load()
  window.addEventListener("online", () => {
    online = true
    scheduleFlush()
  })
  window.addEventListener("offline", () => {
    online = false
  })
}

export function configureSync(opts: {
  client: AppSupabaseClient | null
  userId: string | null
}): void {
  ensureInit()
  client = opts.client
  userId = opts.userId
  if (gateOpen()) scheduleFlush()
}

export function enqueue(op: Omit<SyncOp, "clientOpId"> & { clientOpId?: string }): void {
  ensureInit()
  const clientOpId = op.clientOpId ?? cryptoRandomId()
  state.ops.push({ ...op, clientOpId } as SyncOp)
  persist()
  scheduleFlush()
}

export function pendingOpCount(): number {
  return state.ops.length
}

/**
 * Resolves when the queue is empty (all ops succeeded or were dropped).
 * Resolves anyway after `timeoutMs` so callers can never wedge waiting
 * on a queue that can't make progress (e.g. permanently offline).
 *
 * Cloud-pull uses this so we never overwrite local-only edits with stale
 * cloud state.
 */
export function whenDrained(timeoutMs = 30_000): Promise<void> {
  if (state.ops.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (state.ops.length === 0 || Date.now() - t0 > timeoutMs) {
        resolve()
        return
      }
      setTimeout(tick, 200)
    }
    tick()
  })
}

/** For tests / hard resets. Drops every pending op. */
export function resetSyncQueue(): void {
  state = { ops: [], notBefore: 0 }
  persist()
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return uuid()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
