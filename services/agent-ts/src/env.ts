/**
 * Process-wide settings loaded from environment.
 *
 * Mirrors `services/agent-py/src/agent_py/settings.py` — same env-var
 * names so a single `.env` in the repo root covers Next.js, agent-py,
 * and agent-ts. Validation is via zod; an invalid env crashes the
 * boot so the operator sees the problem before a request comes in.
 *
 * Phase 0 of PLAN-agent-ts. Phase 1+ extends with poll-loop / worker
 * settings; Phase 2+ with the per-user feature-flag value to match.
 */

import { z } from "zod"

const EnvSchema = z.object({
  // --- Service identity ----------------------------------------------
  SERVICE_NAME: z.string().default("agent-ts"),
  SERVICE_PORT: z.coerce.number().int().positive().default(8001),

  // --- Supabase ------------------------------------------------------
  /** Used by /readyz to confirm the data layer is reachable. Empty is
   *  fine in dev; /readyz just reports `supabase: not configured`. */
  SUPABASE_URL: z.string().default(""),
  /** Required by `/v1/whoami` and every auth-protected endpoint. When
   *  empty those endpoints return 503 (a distinct signal from 401 so
   *  monitoring can alert on misconfig). */
  SUPABASE_JWT_SECRET: z.string().default(""),
  /** Direct Postgres connection string (`postgresql://...`). Required
   *  for the Phase 1+ poll loop — when empty the poller still starts
   *  but no-ops on every tick. Use the *direct* connection, NOT the
   *  transaction pooler — `FOR UPDATE SKIP LOCKED` needs an open
   *  transaction. */
  SUPABASE_DB_URL: z.string().default(""),
  /** Service-role key for Supabase Storage REST API access.
   *  When set together with `SUPABASE_URL`, generated images get
   *  mirrored into `user-files/<user_id>/generated/...`. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),

  // --- Worker --------------------------------------------------------
  /** Phase 1 default: claim jobs, log them, release back to the queue.
   *  Flip to false in Phase 2+ when the executor branch lands. */
  WORKER_DRY_RUN: z.coerce.boolean().default(true),
  POLL_INTERVAL_SECONDS: z.coerce.number().positive().default(5),

  // --- Model providers ----------------------------------------------
  /** Anthropic key. Empty falls back to the Phase 2a stub step fn so
   *  the executor stays runnable in development without a live key. */
  ANTHROPIC_API_KEY: z.string().default(""),
  /** Optional Anthropic base-URL override. Same plumbing as agent-py. */
  ANTHROPIC_BASE_URL: z.string().default(""),

  // --- Web search ----------------------------------------------------
  /** Tavily key — registers `webSearch` in the default tool registry. */
  TAVILY_API_KEY: z.string().default(""),

  // --- Image generation ---------------------------------------------
  MINIMAX_CN_API_KEY: z.string().default(""),
  MINIMAX_CN_BASE_URL: z.string().default(""),

  // --- MCP -----------------------------------------------------------
  /** Symmetric key for decrypting cloud-mode MCP server credentials.
   *  Same env var the Next.js side reads. */
  MCP_ENCRYPTION_KEY: z.string().default(""),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | null = null

/** Process-wide settings singleton. First call parses + validates;
 *  subsequent calls return the cached value. Mirrors agent-py's
 *  `lru_cache(get_settings)`. */
export function getEnv(): Env {
  if (cached !== null) return cached
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    // Crash on bad config — the operator should see this before
    // traffic hits the service.
    throw new Error(
      `agent-ts env validation failed: ${parsed.error.message}`,
    )
  }
  cached = parsed.data
  return cached
}

/** Test helper — clear the cache so a test that mutates `process.env`
 *  sees its changes on the next `getEnv()` call. */
export function resetEnvCacheForTest(): void {
  cached = null
}
