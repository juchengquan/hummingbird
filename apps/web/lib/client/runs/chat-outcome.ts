import "client-only"

/**
 * What chat does when a run session ends — the pure decision behind
 * `chat-runner.ts`'s outcome handling (README § 4b-A step 5), so the rules
 * are testable without a store or a stream.
 */

import { shouldAutoRetry } from "@/client/chat/auto-retry-decision"
import type { MessageError } from "@/shared/types"

import { RUN_ANSWER_APPLIED } from "./errors"
import type { PendingInterrupt } from "./interrupts"
import type { RunOutcome } from "./reducer"

/** How the session was opened: a new turn, a rejoin after a reload, or
 *  the resume of a paused turn (an answer to its interrupts). */
export type RunTurnKind = "send" | "rejoin" | "resume"

export type RunOutcomePlan =
  /** Detached (Stop whose cancel failed, unmount, a deleted conversation):
   *  leave the message and the pointer — the run goes on server-side. */
  | { kind: "detached" }
  /** Today's finalisation: auto-archive, reasoning duration, tool calls,
   *  memory extraction (skipped when `tainted`). */
  | { kind: "finalize"; tainted: boolean }
  /** Succeeded without output — today's "empty response" bubble. */
  | { kind: "empty"; error: MessageError }
  /** A network failure before any output: start the same body again
   *  (same run id — an idempotent retry), once. */
  | { kind: "retry" }
  /** The run (or its request) failed: the bubble. */
  | { kind: "error"; error: MessageError }
  /** A rejoin found the run gone (`not_found`): drop the pointer, leave
   *  the message as persisted. */
  | { kind: "forgotten" }
  /** Stopped: as an abort today — an empty placeholder is dropped. */
  | { kind: "cancelled"; dropPlaceholder: boolean }
  /** Paused on interrupts: persist the finished tool calls, hand the
   *  interrupts to the answer cards. */
  | { kind: "interrupt"; interrupts: PendingInterrupt[] }
  /** A resume whose run never started (409 `run_already_resumed`,
   *  `invalid_state`, …): no bubble, the paused turn stays — the answer
   *  card reports `error` / `code`. */
  | { kind: "rejected"; error: MessageError; code: string }
  /** A resume refused because an earlier resume of the same paused run
   *  applied the answers and then ended (409 `run_answer_applied`, Q63):
   *  the question can't be answered again. The paused turn's cards and
   *  pointer go, and the message gets the bubble whose Retry sends the
   *  turn again as a new message. */
  | { kind: "answer-applied"; error: MessageError }

export interface RunOutcomeInputs {
  outcome: RunOutcome | null
  turn: RunTurnKind
  /** The run's output so far (`hasOutput(state.view)`). */
  hasOutput: boolean
  /** `RUN_STARTED` arrived. */
  started: boolean
  /** This session is already the auto-retry. */
  isRetry: boolean
  offline: boolean
  model?: string
}

function withModel(error: MessageError, model: string | undefined): MessageError {
  return model && !error.model ? { ...error, model } : error
}

export function planRunOutcome(i: RunOutcomeInputs): RunOutcomePlan {
  const { outcome } = i
  if (outcome === null) return { kind: "detached" }
  switch (outcome.type) {
    case "success":
      // A resume continues a message that already has the paused run's
      // output; finishing without more is still a finished answer.
      if (!i.hasOutput && i.turn !== "resume") {
        return {
          kind: "empty",
          error: { code: "provider", model: i.model, detail: "The model returned an empty response." },
        }
      }
      return { kind: "finalize", tainted: outcome.memoryTainted }
    case "interrupt":
      return { kind: "interrupt", interrupts: outcome.interrupts }
    case "cancelled":
      return { kind: "cancelled", dropPlaceholder: i.turn === "send" && !i.hasOutput }
    case "error": {
      if (i.turn === "rejoin" && outcome.code === "not_found") return { kind: "forgotten" }
      if (i.turn === "resume" && !i.started) {
        if (outcome.code === RUN_ANSWER_APPLIED) {
          const error: MessageError = { code: "answer_applied" }
          if (outcome.error.status) error.status = outcome.error.status
          return { kind: "answer-applied", error: withModel(error, i.model) }
        }
        return { kind: "rejected", error: withModel(outcome.error, i.model), code: outcome.code }
      }
      if (
        i.turn === "send" &&
        outcome.code === "network" &&
        shouldAutoRetry({ isRetry: i.isRetry, offline: i.offline, placeholderEmpty: !i.hasOutput })
      ) {
        return { kind: "retry" }
      }
      return { kind: "error", error: withModel(outcome.error, i.model) }
    }
  }
}

/** What the plan does to the conversation's active-run pointer. */
export function pointerActionFor(plan: RunOutcomePlan): "keep" | "interrupted" | "clear" {
  switch (plan.kind) {
    case "detached":
    case "retry":
    case "rejected":
    // The resume never started: its own run has no pointer. The paused
    // run's pointer is dropped by the runner, which knows its id.
    case "answer-applied":
      return "keep"
    case "interrupt":
      return "interrupted"
    default:
      return "clear"
  }
}

/** A leading + trailing throttle for the cursor writes (`onCursor`). */
export function createThrottle<T>(
  fn: (value: T) => void,
  ms: number,
  clock: {
    now: () => number
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  } = {
    now: () => Date.now(),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): { push(value: T): void; cancel(): void } {
  let last = -Infinity
  let pending: { value: T } | null = null
  let timer: unknown = null
  const fire = () => {
    timer = null
    if (!pending) return
    const { value } = pending
    pending = null
    last = clock.now()
    fn(value)
  }
  return {
    push(value) {
      pending = { value }
      if (timer !== null) return
      const wait = last + ms - clock.now()
      if (wait <= 0) fire()
      else timer = clock.setTimeout(fire, wait)
    },
    cancel() {
      pending = null
      if (timer !== null) clock.clearTimeout(timer)
      timer = null
    },
  }
}
