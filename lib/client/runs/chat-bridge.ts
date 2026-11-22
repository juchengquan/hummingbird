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
 *
 * **A turn's lifecycle once answered** (one behaviour, both sides):
 *
 * 1. The cards send every answer at once and show "Sending your answer…"
 *    (locked) while the bridge checks them and asks for the resume run.
 * 2. **Refused before the resume run starts** (`run_already_resumed`,
 *    `invalid_state`, `invalid_answers`, `busy`, `not_found`,
 *    `not_on_runs`, `network`): `answerInterrupts` resolves `{ ok: false,
 *    code }`; the turn, its cards and the message are untouched and the
 *    cards show the failure (answered elsewhere / expired → resend /
 *    retry).
 * 3. **The resume run started** (its `RUN_STARTED`): in this order, the
 *    answered generative-UI parts (`AnswerOptions.uiParts`) are written to
 *    the message — inert, as `/api/chat`'s answered parts — the resume's
 *    **base** (the message as the paused run left it *plus* those parts)
 *    is saved for a reload (`run-base.ts`), and the turn is cleared: the
 *    cards disappear and the resume's output streams into the same
 *    message, after the base. A reset of the resume run (a rejoin after a
 *    reload) restores that base, answered parts included.
 * 4. From then on the resume is a send: an error is the message's bubble,
 *    a further interrupt sets a new turn (new run id → new cards), and
 *    `answerInterrupts` resolves `{ ok: true }` once the run settles.
 */

import { create } from "zustand"

import type { PersistedUiPart } from "@/shared/generative-ui/schemas"
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
  /** The paused run's MCP allow-list (Q51): `[]` is no MCP, absent is no
   *  restriction. */
  allowedMcpServerIds?: string[]
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

export interface AnswerOptions {
  /** The answered generative-UI parts (`answeredUiParts`): written to the
   *  message when the resume run starts, before its output (step 3). */
  uiParts?: readonly PersistedUiPart[]
}

export interface ChatRunBridge {
  /**
   * Continue `turn` in the same assistant message with one answer per open
   * interrupt (keyed by `PendingInterrupt.id`). `{ ok: false }` only when
   * the resume run never started (the turn is then untouched); otherwise
   * the turn is cleared as the run starts and this resolves `{ ok: true }`
   * once the run settles and its outcome has been handled like a send's
   * (including a further interrupt, which sets a new turn). See the
   * lifecycle above.
   */
  answerInterrupts(
    turn: InterruptedTurn,
    answers: Record<string, InterruptAnswer>,
    opts?: AnswerOptions,
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
