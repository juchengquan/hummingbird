import "server-only"

import type { User } from "@supabase/supabase-js"
import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/server/supabase/server"
import { AUTH_REQUIRED_CODE, AUTH_REQUIRED_MESSAGE } from "@/shared/api-errors"
import { isSupabaseConfigured } from "@/shared/supabase/env"

/**
 * Sign-in gate for the routes that spend model / compute budget
 * (`/api/chat`, `/api/summarize`, `/api/ai/*`, …).
 *
 * Policy (`REQUIRE_AUTH_FOR_AI`, default off):
 *   - flag off, or Supabase not configured → pass-through. Anonymous
 *     mode keeps working for local / dev exactly as before, and no
 *     Supabase round-trip is made.
 *   - flag on + Supabase configured → the caller must have a valid
 *     Supabase session, verified with `auth.getUser()` (which asks the
 *     auth server; `getSession()` only decodes the cookie and can be
 *     forged). Anything else — no cookie, expired session, auth-server
 *     error, cookie store unavailable — is a
 *     `401 { code: "auth_required", message }`. Fail closed.
 *
 * Flag parsing is strict: `true` / `false` / `1` / `0` (case-insensitive,
 * surrounding whitespace ignored), or unset / empty = off. Any other
 * value throws `RequireAuthConfigError` — a typo like `yes` or `ture`
 * must not silently leave the AI routes open, so every gated route
 * fails with a 500 (and the error is logged) until the value is fixed.
 */

export const REQUIRE_AUTH_FOR_AI_ENV = "REQUIRE_AUTH_FOR_AI"

export class RequireAuthConfigError extends Error {
  constructor(raw: string) {
    super(
      `${REQUIRE_AUTH_FOR_AI_ENV} must be one of true/false/1/0 (got ${JSON.stringify(raw)}).`,
    )
    this.name = "RequireAuthConfigError"
  }
}

/** Parse the raw env value. Unset / empty → false; invalid → throws. */
export function parseRequireAuthFlag(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase()
  if (value === "" || value === "false" || value === "0") return false
  if (value === "true" || value === "1") return true
  throw new RequireAuthConfigError(raw ?? "")
}

/** Minimal surface of the Supabase client the gate needs. */
interface AuthClient {
  auth: {
    getUser: () => Promise<{
      data: { user: User | null }
      error: unknown
    }>
  }
}

export interface AiAuthDeps {
  env: () => string | undefined
  supabaseConfigured: () => boolean
  getClient: () => Promise<AuthClient | null>
}

/**
 * Production dependencies. Exported (and mutable) as a test seam so
 * route-level tests can swap the Supabase client without a
 * process-global `mock.module` — those can't be restored in bun and
 * leak into unrelated test files (see scripts/run-tests.sh).
 */
export const aiAuthDeps: AiAuthDeps = {
  env: () => process.env[REQUIRE_AUTH_FOR_AI_ENV],
  supabaseConfigured: isSupabaseConfigured,
  getClient: getSupabaseServerClient,
}

let warnedUnconfigured = false

export type AiAuthResult =
  /** `user` is null when the gate is inactive (flag off / no Supabase). */
  | { ok: true; user: User | null }
  | { ok: false; response: NextResponse }

export function authRequiredResponse(): NextResponse {
  return NextResponse.json(
    { code: AUTH_REQUIRED_CODE, message: AUTH_REQUIRED_MESSAGE },
    { status: 401 },
  )
}

/** True when the gate is active (flag on AND Supabase configured).
 *  Throws `RequireAuthConfigError` on an invalid flag value. */
export function isAiAuthRequired(deps: AiAuthDeps = aiAuthDeps): boolean {
  if (!parseRequireAuthFlag(deps.env())) return false
  if (!deps.supabaseConfigured()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true
      console.warn(
        `[require-ai-auth] ${REQUIRE_AUTH_FOR_AI_ENV} is on but Supabase isn't configured — ignoring (anonymous AI calls stay allowed).`,
      )
    }
    return false
  }
  return true
}

/**
 * Call at the top of a gated route handler, before reading the body or
 * doing any model / compute work:
 *
 * ```ts
 * const auth = await requireAiAuth()
 * if (!auth.ok) return auth.response
 * ```
 */
export async function requireAiAuth(
  deps: AiAuthDeps = aiAuthDeps,
): Promise<AiAuthResult> {
  if (!isAiAuthRequired(deps)) return { ok: true, user: null }
  try {
    const client = await deps.getClient()
    if (!client) return { ok: false, response: authRequiredResponse() }
    const { data, error } = await client.auth.getUser()
    if (error || !data.user) return { ok: false, response: authRequiredResponse() }
    return { ok: true, user: data.user }
  } catch {
    return { ok: false, response: authRequiredResponse() }
  }
}
