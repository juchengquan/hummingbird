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
 */

import {
  AGENT_PY_BASE_URL,
  AGENT_TS_BASE_URL,
  type ChatBackendOption,
} from "@/client/api-client"
import { useStore } from "@/client/hooks/use-store"

export interface RemoteBackendContext {
  /** `'python'` → agent-py, `'ts-service'` → agent-ts. Never `'ts'`. */
  backend: Exclude<ChatBackendOption, "ts">
  baseUrl: string
  authToken: string
}

/** Read the current backend choice from the store and, if it points
 *  at a remote service, resolve the Supabase JWT lazily. The async
 *  hop is unavoidable because `supabase.auth.getSession()` is async
 *  — but the in-Next fast path returns `null` synchronously after
 *  awaiting nothing, so the cost is one microtask. */
export async function resolveRemoteBackend(): Promise<RemoteBackendContext | null> {
  const backend = useStore.getState().chatBackend
  if (backend === "ts") return null

  const baseUrl =
    backend === "python" ? AGENT_PY_BASE_URL : AGENT_TS_BASE_URL
  if (!baseUrl) return null

  let authToken: string | null = null
  try {
    const { getSupabaseBrowserClient } = await import(
      "@/client/supabase/client"
    )
    const supa = getSupabaseBrowserClient()
    if (supa) {
      const { data } = await supa.auth.getSession()
      authToken = data.session?.access_token ?? null
    }
  } catch {
    // Supabase unconfigured or session lookup failed — fall through
    // to the in-Next route as a defensive default. Mirrors the chat
    // pipeline's behaviour.
    return null
  }

  if (!authToken) return null
  return { backend, baseUrl, authToken }
}
