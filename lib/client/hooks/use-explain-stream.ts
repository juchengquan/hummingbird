"use client"
import "client-only"

import { useEffect, useState } from "react"

import { notifyAuthRequired } from "@/client/auth/auth-required"
import { streamExplanation } from "@/client/chat/explain-stream"
import { noModelProvider } from "@/shared/served-models"
import type { Message, ToolCallResult } from "@/shared/types"

const NO_TOOL_RESULTS: ToolCallResult[] = []

interface UseExplainStreamArgs {
  selection: string
  contextMessages: Message[]
  model: string
  workspaceSystemPrompt?: string
}

interface UseExplainStreamResult {
  /** Streamed markdown so far. */
  streamed: string
  /** Source rows to pin with the explanation: always empty — a run on
   *  agent-py has no tools (Q135). */
  toolResults: ToolCallResult[]
  /** True once the stream terminates (done, error, network error). */
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
 * an ephemeral run on agent-py on a fresh thread — no tools, not saved
 * anywhere (wave 12, Q125/Q135/Q136). Closing the popover (unmount)
 * cancels it.
 */
export function useExplainStream({
  selection,
  contextMessages,
  model,
  workspaceSystemPrompt,
}: UseExplainStreamArgs): UseExplainStreamResult {
  const [streamed, setStreamed] = useState("")
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    return streamExplanation(
      { selection, contextMessages, model, workspaceSystemPrompt },
      {
        append: (t) => setStreamed((prev) => prev + t),
        reset: () => setStreamed(""),
        error: setErrorMsg,
        authRequired: notifyAuthRequired,
        done: () => setDone(true),
      },
      {
        resolveRunsTarget: async () =>
          (await import("@/client/api/backend-resolver")).resolveRunsTarget(),
        loadSession: () => import("@/client/runs/session"),
        noModelProvider,
      },
    )
    // One popover instance explains one selection; the deps keep it honest.
  }, [selection, contextMessages, model, workspaceSystemPrompt])

  return { streamed, toolResults: NO_TOOL_RESULTS, done, errorMsg }
}
