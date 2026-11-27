"use client"
import "client-only"

/**
 * Resolve the currently-selected chat backend's remote dispatch
 * context — base URL + Supabase session JWT — so non-chat endpoints
 * (URL fetch / summarize / MCP proxy / refresh-url) can honour the
 * Phase 4-2 selector the same way `chat.stream` already does.
 *
 * `chatBackend` is a misnomer at this point — it picks the runtime
 * for every endpoint, not just `/v1/chat`. The store key kept its
 * original name to avoid a migration; this helper reads from it.
 *
 * Returns `null` when the user picked `'ts'` (in-Next route), or
 * when any prerequisite (configured base URL / signed-in Supabase
 * session) is missing — callers fall through to the in-Next route
 * on null so misconfigured deploys degrade safely.
 *
 * `'python-runs'` ("agent-py (runs)", Q33) resolves exactly like
 * `'python'` here — the non-chat endpoints don't know about runs.
 * Chat on runs resolves through `resolveRunsTarget()` instead, which
 * also answers for signed-out users (anonymous runs, Q34).
 */

import {
  AGENT_PY_BASE_URL,
  AGENT_TS_BASE_URL,
  isAgentPyBackend,
  isAgentPyConfigured,
  isAgentTsConfigured,
  type ChatBackendOption,
} from "@/client/api-client"
import { explainOnRuns } from "@/client/chat/explain-stream"
import { useStore } from "@/client/hooks/use-store"
import type { RunsTarget } from "@/client/runs/types"
import { editorAiBackend } from "@/shared/editor-ai/routing"

export interface RemoteBackendContext {
  /** `'python'` / `'python-runs'` → agent-py, `'ts-service'` → agent-ts. Never `'ts'`. */
  backend: Exclude<ChatBackendOption, "ts">
  /** `""` when the backend is served on the page's own origin. */
  baseUrl: string
  authToken: string
}

/** The signed-in Supabase session's access token, or `null` (signed
 *  out, Supabase unconfigured, or the lookup failed). */
async function sessionAccessToken(): Promise<
  { ok: true; token: string | null } | { ok: false }
> {
  try {
    const { getSupabaseBrowserClient } = await import(
      "@/client/supabase/client"
    )
    const supa = getSupabaseBrowserClient()
    if (!supa) return { ok: true, token: null }
    const { data } = await supa.auth.getSession()
    return { ok: true, token: data.session?.access_token ?? null }
  } catch {
    return { ok: false }
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

/** Read the current backend choice from the store and, if it points
 *  at a remote service, resolve the Supabase JWT lazily. The async
 *  hop is unavoidable because `supabase.auth.getSession()` is async
 *  — but the in-Next fast path returns `null` synchronously after
 *  awaiting nothing, so the cost is one microtask. */
export async function resolveRemoteBackend(): Promise<RemoteBackendContext | null> {
  const backend = useStore.getState().chatBackend
  if (backend === "ts") return null

  // `""` is a valid base URL (same origin, `NEXT_PUBLIC_AGENT_*_URL=/`),
  // so gate on "configured", not on the prefix being non-empty.
  const agentPy = isAgentPyBackend(backend)
  const configured = agentPy ? isAgentPyConfigured() : isAgentTsConfigured()
  if (!configured) return null
  const baseUrl = agentPy ? AGENT_PY_BASE_URL : AGENT_TS_BASE_URL

  // Supabase unconfigured or session lookup failed — fall through
  // to the in-Next route as a defensive default. Mirrors the chat
  // pipeline's behaviour.
  const session = await sessionAccessToken()
  if (!session.ok || !session.token) return null
  return { backend, baseUrl, authToken: session.token }
}

/**
 * Where a chat turn on runs goes, or `null` when the user did not pick
 * "agent-py (runs)" or agent-py isn't configured (the caller then
 * keeps today's path). Unlike `resolveRemoteBackend`, a signed-out
 * user still gets a target — `authToken: null`, an anonymous run
 * addressed by its `X-Run-Token` (Q20/Q34) — and so does a failed
 * session lookup (the run is then anonymous; the backend decides
 * whether that's allowed, `401 auth_required`).
 */
export async function resolveRunsTarget(): Promise<RunsTarget | null> {
  if (useStore.getState().chatBackend !== "python-runs") return null
  if (!isAgentPyConfigured()) return null
  const session = await sessionAccessToken()
  const authToken = session.ok ? session.token : null
  return {
    baseUrl: AGENT_PY_BASE_URL,
    authToken,
    ...(authToken ? { getAuthToken: currentAccessToken } : {}),
  }
}

/**
 * Where the Explain-selection popover's run goes (wave 12, Q125), or
 * `null` for the Next route: agent-py's runs API on its backends —
 * `python-runs` and `python` alike (`explainOnRuns`) — signed in (the
 * bearer) or out (an anonymous run). `ts` / `ts-service` keep the Next
 * route until wave 13.
 */
export async function resolveExplainTarget(): Promise<RunsTarget | null> {
  if (!explainOnRuns(useStore.getState().chatBackend, isAgentPyConfigured())) return null
  const session = await sessionAccessToken()
  const authToken = session.ok ? session.token : null
  return {
    baseUrl: AGENT_PY_BASE_URL,
    authToken,
    ...(authToken ? { getAuthToken: currentAccessToken } : {}),
  }
}

/**
 * Where the tasks panel's requests go (wave 6): agent-py's runs API for
 * the signed-in user, or `null` when agent-py isn't configured or nobody
 * is signed in (background runs are signed-in only). Unlike
 * `resolveRunsTarget` it doesn't depend on the selected backend: every
 * task of the user is listed and delivered whatever the selection (Q76);
 * the selection only decides where a new task is launched (Q61,
 * `TasksAvailability`).
 */
export async function resolveTasksTarget(): Promise<RunsTarget | null> {
  if (!isAgentPyConfigured()) return null
  const session = await sessionAccessToken()
  if (!session.ok || !session.token) return null
  return { baseUrl: AGENT_PY_BASE_URL, authToken: session.token, getAuthToken: currentAccessToken }
}

/** Where the editor's AI requests go when agent-py serves them. */
export interface EditorAiTarget {
  baseUrl: string
  /** `null`: anonymous (only on `python-runs`, as chat on runs). */
  authToken: string | null
}

/**
 * Where the editor's AI goes (wave 9, Q102–Q105): agent-py's
 * `/v1/ai/command` + `/v1/ai/complete` where agent-py serves chat
 * (`editorAiBackend`), else `null` — the Next routes, on the deploy's key
 * (the own-key setting is gone, Q124).
 */
export async function resolveEditorAiTarget(): Promise<EditorAiTarget | null> {
  const chatBackend = useStore.getState().chatBackend
  if (!isAgentPyConfigured()) return null
  if (chatBackend !== "python" && chatBackend !== "python-runs") return null
  const session = await sessionAccessToken()
  const authToken = session.ok ? session.token : null
  const backend = editorAiBackend({
    agentPyConfigured: true,
    chatBackend,
    signedIn: authToken !== null,
  })
  return backend === "agent-py" ? { baseUrl: AGENT_PY_BASE_URL, authToken } : null
}
