"use client"
import "client-only"

/**
 * Where a call goes: agent-py (`NEXT_PUBLIC_AGENT_PY_URL`), the only
 * backend (wave 13, Q142), with the signed-in Supabase session's access
 * token — or tokenless when there is none (signed out, Supabase
 * unconfigured, or the lookup failed). Nothing here falls back anywhere:
 * agent-py serves some calls anonymously and answers the rest
 * `401 auth_required` ("Sign in required"). A deploy without agent-py
 * shows the no-backend screen (`components/no-backend-gate.tsx`), so no
 * call is made there.
 */

import { AGENT_PY_BASE_URL, type AgentPyTarget } from "@/client/api-client"
import type { RunsTarget } from "@/client/runs/types"

/** The signed-in Supabase session's access token, or `null` (signed
 *  out, Supabase unconfigured, or the lookup failed). */
async function sessionAccessToken(): Promise<string | null> {
  try {
    const { getSupabaseBrowserClient } = await import(
      "@/client/supabase/client"
    )
    const supa = getSupabaseBrowserClient()
    if (!supa) return null
    const { data } = await supa.auth.getSession()
    return data.session?.access_token ?? null
  } catch {
    return null
  }
}

/** The session's current access token, or a refreshed one (`refresh`):
 *  the `RunsTarget.getAuthToken` of a signed-in target, read on every
 *  request so a long watch or stream survives the token it started with
 *  (survey bug 19). `null` once signed out. */
async function currentAccessToken(refresh?: boolean): Promise<string | null> {
  try {
    const { getSupabaseBrowserClient } = await import("@/client/supabase/client")
    const supa = getSupabaseBrowserClient()
    if (!supa) return null
    if (refresh) {
      const { data } = await supa.auth.refreshSession()
      if (data.session?.access_token) return data.session.access_token
    }
    const { data } = await supa.auth.getSession()
    return data.session?.access_token ?? null
  } catch {
    return null
  }
}

/** agent-py with the session's token, or tokenless (`authToken: null`):
 *  every non-runs call (`apiClient.*`) and the editor's AI. */
export async function resolveAgentPyTarget(): Promise<AgentPyTarget> {
  return { baseUrl: AGENT_PY_BASE_URL, authToken: await sessionAccessToken() }
}

/**
 * Where a run goes — a chat turn, an Explain popover (Q125), a paused
 * turn's resume: agent-py's runs API. Signed in it carries the bearer and
 * re-reads it per request (`getAuthToken`); signed out (or a failed
 * session lookup) it is an anonymous run, addressed by its `X-Run-Token`
 * (Q20/Q34) — the backend decides whether that's allowed
 * (`401 auth_required`).
 */
export async function resolveRunsTarget(): Promise<RunsTarget> {
  const authToken = await sessionAccessToken()
  return {
    baseUrl: AGENT_PY_BASE_URL,
    authToken,
    ...(authToken ? { getAuthToken: currentAccessToken } : {}),
  }
}

/**
 * Where the tasks panel's requests go (wave 6): agent-py's runs API for
 * the signed-in user, or `null` when nobody is signed in (background runs
 * are signed-in only, and the tasks interface lists nothing signed out).
 */
export async function resolveTasksTarget(): Promise<RunsTarget | null> {
  const token = await sessionAccessToken()
  if (!token) return null
  return { baseUrl: AGENT_PY_BASE_URL, authToken: token, getAuthToken: currentAccessToken }
}
