"use client"
import "client-only"

import { useEffect, useState } from "react"

import { apiClient } from "@/client/api-client"
import { notifyAuthRequired } from "@/client/auth/auth-required"
import { streamExplanation } from "@/client/chat/explain-stream"
import { noModelProvider } from "@/shared/served-models"
import type { Message, ToolCallResult } from "@/shared/types"

interface UseExplainStreamArgs {
  selection: string
  contextMessages: Message[]
  model: string
  workspaceSystemPrompt?: string
  skills?: Array<{ id: string }>
}

interface UseExplainStreamResult {
  /** Streamed markdown so far. */
  streamed: string
  /** Source rows captured from any tool_result frame with results
   *  (`webSearch` — the Next route only; a run on agent-py has no tools). */
  toolResults: ToolCallResult[]
  /** True once the stream terminates (done, error, network error, or the
   *  Next route's no-key mock). */
  done: boolean
  /** Non-null when the stream failed in a way the popover/sheet should
   *  surface in destructive style. */
  errorMsg: string | null
}

/**
 * Owns the streaming lifecycle for selection-driven Explain. Both
 * `ExplainPopover` (desktop) and `ExplainSheet` (mobile) consume the same
 * state; the only difference is layout.
 *
 * Where it runs is `streamExplanation`'s (`lib/client/chat/explain-stream.ts`):
 * on agent-py's backends an ephemeral run on a fresh thread — no tools, not
 * saved anywhere (wave 12, Q125/Q135/Q136); on `ts` / `ts-service` the Next
 * chat route, with the labelled mock on a missing AI key. Closing the
 * popover (unmount) cancels it.
 */
export function useExplainStream({
  selection,
  contextMessages,
  model,
  workspaceSystemPrompt,
  skills,
}: UseExplainStreamArgs): UseExplainStreamResult {
  const [streamed, setStreamed] = useState("")
  const [toolResults, setToolResults] = useState<ToolCallResult[]>([])
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    return streamExplanation(
      { selection, contextMessages, model, workspaceSystemPrompt, skills },
      {
        append: (t) => setStreamed((prev) => prev + t),
        reset: () => setStreamed(""),
        sources: setToolResults,
        mock: setStreamed,
        error: setErrorMsg,
        authRequired: notifyAuthRequired,
        done: () => setDone(true),
      },
      {
        resolveRunsTarget: async () =>
          (await import("@/client/api/backend-resolver")).resolveExplainTarget(),
        loadSession: () => import("@/client/runs/session"),
        chatStream: apiClient.chat.stream,
        noModelProvider,
      },
    )
    // One popover instance explains one selection; the deps keep it honest.
  }, [selection, contextMessages, model, workspaceSystemPrompt, skills])

  return { streamed, toolResults, done, errorMsg }
}
