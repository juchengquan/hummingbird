import "client-only"

/**
 * Mounted by the chat panel: once the store has hydrated, rebuild the
 * interrupted turns of chat on runs from the active-run pointers
 * (`restoreInterruptedTurns`).
 */

import { useEffect } from "react"

import { apiClient } from "@/client/api-client"
import { resolveRunsTarget } from "@/client/api/backend-resolver"
import { useStore } from "@/client/hooks/use-store"

import { clearActiveRun, listActiveRuns } from "./active-run"
import { useInterruptedTurns } from "./chat-bridge"
import { restoreInterruptedTurns } from "./restore-interrupted"

export function useRestoreInterruptedTurns(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const records = listActiveRuns().filter((r) => r.status === "interrupted")
    if (records.length === 0) return
    let cancelled = false
    void (async () => {
      const target = await resolveRunsTarget()
      if (cancelled) return
      await restoreInterruptedTurns({
        target,
        records,
        messageExists: (conversationId, messageId) =>
          useStore
            .getState()
            .conversations.some(
              (c) => c.id === conversationId && c.messages.some((m) => m.id === messageId),
            ),
        hasTurn: (conversationId) => !!useInterruptedTurns.getState().byConversation[conversationId],
        getRun: (runId) => apiClient.runs.status(runId, { target }),
        setTurn: (turn) => {
          if (!cancelled) useInterruptedTurns.getState().setInterruptedTurn(turn)
        },
        clearPointer: (conversationId, runId) => clearActiveRun(conversationId, runId),
      })
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])
}
