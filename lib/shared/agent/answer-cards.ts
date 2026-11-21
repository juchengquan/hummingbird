/**
 * The answer cards' model — what a paused agent asks the human, and what
 * the human answers — independent of where the question came from:
 *
 * - the task strip (`PendingInput`, answered via `/api/tasks/:id/respond`),
 * - chat on runs (`PendingInterrupt`, answered by resuming the run —
 *   Q24/Q35; the adapter is `lib/client/runs/interrupt-answers.ts`).
 *
 * The cards (`components/agent/interrupt-cards/`) render an
 * `AnswerQuestion` and emit a `CardAnswer`; each surface maps the answer
 * to its own wire shape. Pure — no React, no I/O.
 */

import type { RespondRequestInput } from "@/shared/api-schemas"
import {
  respondBodyForUiAnswer,
  type UiAnswer,
  type UiKind,
} from "@/shared/generative-ui/schemas"

import type { PendingInput } from "@/shared/agent/project"

/** The four kinds of question a card can answer. */
export type AnswerReason = "approval" | "choice" | "input" | "ui-part"

export const ANSWER_REASONS: readonly AnswerReason[] = ["approval", "choice", "input", "ui-part"]

export function isAnswerReason(reason: string): reason is AnswerReason {
  return (ANSWER_REASONS as readonly string[]).includes(reason)
}

/** One question, as the cards see it. */
export interface AnswerQuestion {
  /** The request / interrupt id — also keys the card's form controls. */
  id: string
  reason: AnswerReason
  /** `approval`: the gated tool and its arguments. */
  tool?: string
  args?: unknown
  /** `choice` / `input`: the question text. */
  prompt?: string
  /** `choice`: the options, and whether several may be picked. */
  options?: Array<{ id: string; label: string }>
  multi?: boolean
  /** `ui-part`: the generative-UI kind + props to render as the card. */
  uiKind?: string
  uiProps?: unknown
}

/** What a card emits. `ui-part` answers carry the part they answer, so
 *  each surface can format them (`respondBodyForUiAnswer`). */
export type CardAnswer =
  | { approved: boolean }
  | { selection: string[] }
  | { value: string }
  | { uiAnswer: UiAnswer; part: { kind: UiKind; props: unknown } }

/** The task strip's question (its `kind` defaults to `approval`). */
export function questionFromPendingInput(input: PendingInput): AnswerQuestion {
  return {
    id: input.requestId,
    reason: input.kind ?? "approval",
    tool: input.tool,
    args: input.args,
    prompt: input.prompt,
    options: input.options,
    multi: input.multi,
    uiKind: input.uiKind,
    uiProps: input.uiProps,
  }
}

/** The `/api/tasks/:id/respond` body for a card's answer — exactly what
 *  the task strip has always sent: `{ requestId, approved }`,
 *  `{ requestId, selection }`, `{ requestId, value }`, or
 *  `respondBodyForUiAnswer(...)` for a generative-UI part. */
export function respondBodyForCardAnswer(
  requestId: string,
  answer: CardAnswer,
): RespondRequestInput {
  if ("uiAnswer" in answer) {
    return respondBodyForUiAnswer(requestId, answer.part, answer.uiAnswer)
  }
  return { requestId, ...answer }
}

// --- Card form helpers ------------------------------------------------------

/** `choice`: the selection after toggling `id` (multi toggles; single
 *  replaces). */
export function toggleSelection(selected: readonly string[], id: string, multi: boolean): string[] {
  if (!multi) return [id]
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
}

/** `choice`: a selection can be sent once it names at least one option. */
export function canSubmitSelection(selected: readonly string[]): boolean {
  return selected.length > 0
}

/** `input`: an answer can be sent once it has non-blank text. The value
 *  is sent as typed (not trimmed) — as the task strip always has. */
export function canSubmitValue(value: string): boolean {
  return value.trim().length > 0
}

/** Pretty-printed tool arguments for the approval card ("" when none). */
export function formatToolArgs(args: unknown): string {
  if (args == null) return ""
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/** A short, human-readable form of an answer — what an answered card
 *  shows while the others are still open. */
export function describeCardAnswer(question: AnswerQuestion, answer: CardAnswer): string {
  if ("approved" in answer) return answer.approved ? "Approved" : "Rejected"
  if ("selection" in answer) {
    const byId = new Map((question.options ?? []).map((o) => [o.id, o.label]))
    return answer.selection.map((id) => byId.get(id) ?? id).join(", ")
  }
  if ("value" in answer) return answer.value
  return ""
}
