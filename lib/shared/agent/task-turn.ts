/**
 * Resending a task turn (bug 4 of the wave 6 survey): a user message sent
 * as a task records it (`Message.taskTurn`), and every resend of that turn
 * — Edit, Regenerate, Retry, a card's answer — goes as a task again, in
 * the same mode. The newest user message of the history decides, as for
 * the turn's persona (Q52). Pure.
 */

import type { Message, TaskTurn } from "@/shared/types"

/** The task mode of the turn `history` ends with, or undefined for a chat turn. */
export function latestTaskTurn(history: readonly Pick<Message, "role" | "taskTurn">[]): TaskTurn | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].taskTurn
  }
  return undefined
}

/** The send options that resend `history`'s turn as it was sent. */
export function resendAs(
  history: readonly Pick<Message, "role" | "taskTurn">[],
): { asTask?: true; taskMode?: TaskTurn["mode"] } {
  const turn = latestTaskTurn(history)
  return turn ? { asTask: true, taskMode: turn.mode } : {}
}
