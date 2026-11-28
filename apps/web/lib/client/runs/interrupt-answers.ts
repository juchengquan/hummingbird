import "client-only"

/**
 * Chat's answer cards on runs (Q35), the pure half: a `PendingInterrupt`
 * as an answer-card question, a card's answer as an `InterruptAnswer`, and
 * what an `answerInterrupts` failure means for the cards. The React half
 * is `components/chat/interrupted-turn-cards.tsx`; the cards themselves
 * are shared with the task strip (`components/agent/interrupt-cards/`).
 *
 * Pure, except `submitTurnAnswers` / `recheckAnsweredRun`, which take the
 * bridge / the status call as arguments.
 */

import {
  describeCardAnswer,
  isAnswerReason,
  type AnswerQuestion,
  type CardAnswer,
} from "@/shared/agent/answer-cards"
import {
  parsePersistedUiPart,
  respondBodyForUiAnswer,
  type PersistedUiPart,
} from "@/shared/generative-ui/schemas"
import type { MessageError } from "@/shared/types"

import type { AnswerResult, ChatRunBridge, InterruptedTurn } from "./chat-bridge"
import { isRunsError } from "./errors"
import { pendingInterrupts, type InterruptAnswer, type PendingInterrupt } from "./interrupts"
import type { Run } from "./types"

/** A card's answer, or "dismiss it" (`{ cancelled: true }`) — the only
 *  answer an expired interrupt, or one of a reason this client doesn't
 *  know, can take. */
export type DraftAnswer = CardAnswer | { cancelled: true }

/** The card for an interrupt, or `null` when its reason is not one the
 *  cards can answer (it can then only be dismissed). */
export function questionFromInterrupt(interrupt: PendingInterrupt): AnswerQuestion | null {
  if (!isAnswerReason(interrupt.reason)) return null
  return {
    id: interrupt.id,
    reason: interrupt.reason,
    tool: interrupt.tool,
    args: interrupt.args,
    prompt: interrupt.message,
    options: interrupt.options,
    multi: interrupt.multi,
    uiKind: interrupt.uiKind,
    uiProps: interrupt.uiProps,
  }
}

/**
 * The resume payload for a card's answer (RUN_EVENTS.md § 4.2). A
 * generative-UI answer is `{ uiAnswer }` plus the respond route's
 * back-compat `value` (the answer as text — what the model is shown) /
 * `selection` (a `choice` part's ids): never a synthetic user message.
 */
export function interruptAnswerFor(draft: DraftAnswer): InterruptAnswer {
  if ("cancelled" in draft) return { cancelled: true }
  if ("uiAnswer" in draft) {
    // The respond route's body minus `requestId` (the resume entry is
    // keyed by `interruptId`).
    const body = respondBodyForUiAnswer("", draft.part, draft.uiAnswer)
    const payload: { uiAnswer: Record<string, unknown>; value?: string; selection?: string[] } = {
      uiAnswer: body.uiAnswer,
    }
    if (body.value !== undefined) payload.value = body.value
    if (body.selection !== undefined) payload.selection = body.selection
    return payload
  }
  return draft
}

/** Every open interrupt's resume answer, or `null` while one is still
 *  unanswered (`buildResume` requires them all). */
export function resumeAnswers(
  interrupts: readonly PendingInterrupt[],
  drafts: Readonly<Record<string, DraftAnswer>>,
): Record<string, InterruptAnswer> | null {
  const out: Record<string, InterruptAnswer> = {}
  for (const i of interrupts) {
    const draft = drafts[i.id]
    if (!draft) return null
    out[i.id] = interruptAnswerFor(draft)
  }
  return out
}

/** True once `expiresAt` has passed: the interrupt can only be dismissed. */
export function isInterruptExpired(interrupt: Pick<PendingInterrupt, "expiresAt">, now: number): boolean {
  if (!interrupt.expiresAt) return false
  const at = Date.parse(interrupt.expiresAt)
  return Number.isFinite(at) && at <= now
}

/** Milliseconds until the next of these interrupts expires (`null` when
 *  none will) — when the cards must re-render. */
export function msUntilNextExpiry(interrupts: readonly PendingInterrupt[], now: number): number | null {
  let next: number | null = null
  for (const i of interrupts) {
    if (!i.expiresAt) continue
    const at = Date.parse(i.expiresAt)
    if (!Number.isFinite(at) || at <= now) continue
    next = next === null ? at - now : Math.min(next, at - now)
  }
  return next
}

/** What an answered (not yet sent) card shows in place of its controls. */
export function describeDraft(question: AnswerQuestion | null, draft: DraftAnswer): string {
  if ("cancelled" in draft) return "Dismissed"
  if (!question) return ""
  return describeCardAnswer(question, draft)
}

export type AnswerFailure =
  /** `409 run_already_resumed`: another tab / device answered first. */
  | { kind: "answered-elsewhere" }
  /** `409 run_answer_applied` (Q63): an earlier answer was applied and its
   *  run ended — the question is dead. The runner has already dropped
   *  the turn (these cards unmount) and put the bubble on the message. */
  | { kind: "applied" }
  /** `409 invalid_state`: the run can't be resumed any more (an anonymous
   *  run past its memory TTL) — offer to resend the user's message. */
  | { kind: "expired" }
  /** Anything else: show it, keep the answers, offer a retry. */
  | { kind: "error"; message: string }

export function classifyAnswerFailure(result: Extract<AnswerResult, { ok: false }>): AnswerFailure {
  if (result.code === "run_already_resumed") return { kind: "answered-elsewhere" }
  if (result.code === "run_answer_applied") return { kind: "applied" }
  if (result.code === "invalid_state") return { kind: "expired" }
  return { kind: "error", message: answerErrorText(result.error) }
}

const ERROR_TEXT: Record<string, string> = {
  auth: "Authentication failed.",
  auth_required: "Sign in to continue this answer.",
  rate_limit: "Rate limited — wait a moment and try again.",
  context_window: "The conversation is too long to continue.",
  invalid_model: "The model is unavailable.",
  unknown_model: "This model isn't available on this server.",
  invalid_attachment: "An attached file or image can't be sent to the model.",
  provider: "The model provider returned an error.",
  network: "Network error — check your connection.",
  answer_applied: "This answer was already acted on — send your message again.",
  unknown: "Something went wrong.",
}

/** The one-line inline error under the cards. */
export function answerErrorText(error: MessageError): string {
  const base = ERROR_TEXT[error.code] ?? ERROR_TEXT.unknown
  const detail = error.detail?.trim()
  return detail && error.code === "unknown" ? `${base} ${detail}` : base
}

/**
 * The generative-UI parts an answer resolves, as answered
 * `Message.uiParts` entries (`answeredAt` + `answer`), so the message
 * keeps showing what was picked — inert, like `/api/chat`'s answered
 * parts — once the cards are gone. The bridge writes them when the resume
 * run starts, before its output (`chat-bridge.ts`, lifecycle step 3).
 * Dismissed parts and parts whose kind / props don't validate are skipped.
 */
export function answeredUiParts(
  turn: Pick<InterruptedTurn, "interrupts">,
  drafts: Readonly<Record<string, DraftAnswer>>,
  answeredAt: string,
): PersistedUiPart[] {
  const out: PersistedUiPart[] = []
  for (const i of turn.interrupts) {
    const draft = drafts[i.id]
    if (i.reason !== "ui-part" || !draft || !("uiAnswer" in draft)) continue
    const part = parsePersistedUiPart({
      id: uiPartIdFor(i),
      kind: draft.part.kind,
      props: draft.part.props,
      answeredAt,
      answer: draft.uiAnswer,
    })
    if (part) out.push(part)
  }
  return out
}

/** The `Message.uiParts` id a `ui-part` interrupt's part has — the
 *  `renderUI` tool call id, as on `/api/chat` (`data-ui`'s `id`). */
export function uiPartIdFor(interrupt: Pick<PendingInterrupt, "id" | "toolCallId">): string {
  return interrupt.toolCallId ?? interrupt.id
}

/** Ids of the `Message.uiParts` an open turn's cards render, which the
 *  message's own part list must therefore skip (never two copies, and
 *  never the `/api/chat` auto-send / composer-prefill path for them). */
export function uiPartIdsOwnedByTurn(turn: Pick<InterruptedTurn, "interrupts"> | undefined): ReadonlySet<string> {
  if (!turn) return EMPTY
  return new Set(turn.interrupts.filter((i) => i.reason === "ui-part").map(uiPartIdFor))
}

const EMPTY: ReadonlySet<string> = new Set()

export type SubmitOutcome =
  /** Not every open interrupt has an answer yet. */
  | { type: "incomplete" }
  /** No bridge registered (chat not mounted): nothing was sent. */
  | { type: "no-bridge" }
  /** The resumed run started (the bridge wrote these answered
   *  generative-UI parts and cleared the turn) and has since settled. */
  | { type: "answered"; uiParts: PersistedUiPart[] }
  | { type: "failed"; failure: AnswerFailure }

/** Send every open interrupt's answer through the bridge — the cards'
 *  submit — with the generative-UI parts they answer, for the bridge to
 *  write when the resume starts. Never throws: a bridge that throws counts
 *  as an `unknown` error. */
export async function submitTurnAnswers(
  turn: InterruptedTurn,
  drafts: Readonly<Record<string, DraftAnswer>>,
  bridge: ChatRunBridge | null,
  now: Date = new Date(),
): Promise<SubmitOutcome> {
  const answers = resumeAnswers(turn.interrupts, drafts)
  if (!answers) return { type: "incomplete" }
  if (!bridge) return { type: "no-bridge" }
  const uiParts = answeredUiParts(turn, drafts, now.toISOString())
  let result: AnswerResult
  try {
    result = await bridge.answerInterrupts(turn, answers, { uiParts })
  } catch (err) {
    result = {
      ok: false,
      error: { code: "unknown", detail: err instanceof Error ? err.message : String(err) },
    }
  }
  if (result.ok) return { type: "answered", uiParts }
  return { type: "failed", failure: classifyAnswerFailure(result) }
}

/**
 * After `run_already_resumed`, re-read the run: `"gone"` when the backend
 * forgot it (404) or it no longer waits for answers — the caller drops the
 * card and the pointer; `"waiting"` when it is still `interrupted` (the
 * usual case: an answered run keeps that status while the other tab's
 * resume continues the turn), and `"unknown"` on any other error.
 */
export async function recheckAnsweredRun(
  runId: string,
  getRun: (runId: string) => Promise<Pick<Run, "status" | "openInterrupts">>,
): Promise<"gone" | "waiting" | "unknown"> {
  try {
    const run = await getRun(runId)
    return pendingInterrupts(run).length === 0 ? "gone" : "waiting"
  } catch (err) {
    return isRunsError(err) && err.kind === "http" && err.status === 404 ? "gone" : "unknown"
  }
}
