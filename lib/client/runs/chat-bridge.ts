import "client-only"

/**
 * The seam between wave 4b-A (chat send on runs, `use-chat-send.ts`) and
 * wave 4b-B (answer cards + resume, Q35). Written before both started so
 * they can be built in parallel; see `README.md` § 4b-A / § 4b-B.
 *
 * - **Interrupted turns** are ephemeral UI state (not persisted, not
 *   synced): which assistant message is paused on which run, and what it
 *   waits for. 4b-A sets one when a run ends with an `interrupt` outcome
 *   and clears it when the conversation moves on; 4b-B renders cards from
 *   it, and after a reload rebuilds it from the active-run pointer
 *   (`status: "interrupted"`) + `apiClient.runs.status`.
 * - **The bridge** is how an answer reaches the send machinery: 4b-A
 *   registers an implementation (it owns the message's sink, the sync hold,
 *   the pointer and the outcome handling — a resumed run may finish, fail,
 *   or interrupt again); 4b-B only calls `answerInterrupts`.
 */

import { create } from "zustand"

import type { MessageError } from "@/shared/types"

import type { InterruptAnswer, PendingInterrupt } from "./interrupts"

export interface InterruptedTurn {
  conversationId: string
  /** The assistant message the paused run writes into (and its resume continues). */
  messageId: string
  /** The interrupted run — the resume's `previousRunId`. */
  runId: string
  threadId: string
  interrupts: PendingInterrupt[]
  /** Signed out when it started: the resume presents the run's `X-Run-Token`. */
  anonymous: boolean
  model?: string
}

export type AnswerResult =
  | { ok: true }
  /**
   * `code` is the runs error code when there is one, e.g.
   * `run_already_resumed` (another tab answered — re-read status) or
   * `invalid_state` (an anonymous run past its memory TTL: "this question
   * expired", offer to resend).
   */
  | { ok: false; error: MessageError; code?: string }

export interface ChatRunBridge {
  /**
   * Continue `turn` in the same assistant message with one answer per open
   * interrupt (keyed by `PendingInterrupt.id`). Resolves once the resumed
   * run settles and its outcome has been handled like a send's (including
   * a further interrupt, which replaces this turn's entry).
   */
  answerInterrupts(
    turn: InterruptedTurn,
    answers: Record<string, InterruptAnswer>,
  ): Promise<AnswerResult>
}

interface InterruptedTurnsState {
  byConversation: Record<string, InterruptedTurn>
  setInterruptedTurn(turn: InterruptedTurn): void
  /** No-op unless `runId` (when given) is still the conversation's entry. */
  clearInterruptedTurn(conversationId: string, runId?: string): void
}

export const useInterruptedTurns = create<InterruptedTurnsState>((set) => ({
  byConversation: {},
  setInterruptedTurn: (turn) =>
    set((s) => ({ byConversation: { ...s.byConversation, [turn.conversationId]: turn } })),
  clearInterruptedTurn: (conversationId, runId) =>
    set((s) => {
      const current = s.byConversation[conversationId]
      if (!current || (runId !== undefined && current.runId !== runId)) return s
      const next = { ...s.byConversation }
      delete next[conversationId]
      return { byConversation: next }
    }),
}))

export function useInterruptedTurn(conversationId: string | null | undefined): InterruptedTurn | undefined {
  return useInterruptedTurns((s) => (conversationId ? s.byConversation[conversationId] : undefined))
}

let bridge: ChatRunBridge | null = null

/** 4b-A: register on mount, call the returned function on unmount. */
export function registerChatRunBridge(impl: ChatRunBridge): () => void {
  bridge = impl
  return () => {
    if (bridge === impl) bridge = null
  }
}

/** 4b-B: the registered bridge, or `null` before chat has mounted. */
export function getChatRunBridge(): ChatRunBridge | null {
  return bridge
}
