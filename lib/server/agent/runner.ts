import "server-only"

/**
 * The agent runner — slice 5 of the event model. Pure orchestration:
 *
 *  - `runAgentLoop` — status → per-step (cancel check → start →
 *    runStep → end) → terminal. The model call is injected as a
 *    `RunStepFn` so the loop's control flow (step budget,
 *    cancellation, event sequencing, settle-once) is unit-testable
 *    with a fake step, no live model needed.
 *
 *  - `makeTokenCoalescer` — exported for unit tests; collapses many
 *    streamed token deltas into one `token` event per channel /
 *    threshold. The agent services use it inside their own
 *    `RunStepFn` implementations.
 *
 * The production `RunStepFn` used to live here (`makeStreamTextStep`)
 * alongside the in-Next worker. Both moved out: the dedicated agent
 * services (`services/agent-py/`, `services/agent-ts/`) own
 * model invocation now.
 *
 * The loop drives a `RunEmitter`; the caller wires its sink to
 * persist (`appendEvent`) + stream. See
 * `docs/PLAN-agent-event-model.md`.
 */

import type { RunEmitter } from "@/shared/agent/emitter"

export interface RunStepContext {
  /** 1-based step number, matching the emitter's current step. */
  step: number
  signal: AbortSignal
  emitter: RunEmitter
}

export interface PendingInputDescriptor {
  /** AI-SDK tool-call id — needed on response to match the result back
   *  to the right pending call. */
  toolCallId: string
  /** Tool name (gated MCP tool, or `askUser`). */
  tool: string
  args?: unknown
}

export interface RunStepOutcome {
  /** false → the model called tools; loop again. true → final answer. */
  done: boolean
  /** Set when the step ended on a no-execute gated tool call — the
   *  runner suspends the run for human input instead of looping. */
  pendingInput?: PendingInputDescriptor
}

export type RunStepFn = (ctx: RunStepContext) => Promise<RunStepOutcome>

/** Outcome of `runAgentLoop`. Three non-terminal possibilities — the
 *  route/worker decides what to do next:
 *  - `settled`: terminal event emitted, nothing more to do.
 *  - `suspended`: HITL pause. Persist checkpoint + emit input request.
 *  - `yielded`: chunk break (we used up our time budget but the run
 *    isn't finished). Persist checkpoint + enqueue a `continue` job.
 *    Status stays `running`; no terminal event is emitted. */
export type AgentLoopResult =
  | { kind: "settled" }
  | { kind: "suspended"; pendingInput: PendingInputDescriptor }
  | { kind: "yielded" }

export interface AgentLoopOptions {
  emitter: RunEmitter
  maxSteps: number
  signal: AbortSignal
  /** Polled before each step so an out-of-band cancel (the DB status
   *  flipped by `/cancel`) stops the run between steps. */
  isCancelled: () => boolean | Promise<boolean>
  /** Polled before each step so the loop can voluntarily yield when
   *  we're close to the serverless function's execution cap. The
   *  current step always finishes; only the next-step gate sees the
   *  yield. Returning `true` produces a `yielded` result without
   *  settling — the route/worker persists the checkpoint and enqueues
   *  a `continue` job. */
  shouldYield?: () => boolean
  runStep: RunStepFn
}

/**
 * Drive a run to completion. Emits exactly one terminal event
 * (`status: cancelled` or `result: done|failed`) — the emitter drops
 * anything after, so a late tool callback can't append past the end.
 */
export async function runAgentLoop(
  opts: AgentLoopOptions
): Promise<AgentLoopResult> {
  const { emitter, maxSteps, signal, isCancelled, shouldYield, runStep } = opts
  // Only emit `status: running` on a fresh start. A continuation
  // invocation (HITL resume) is already at the current step counter
  // (seeded via `startStep`), so the first status emit is the route's
  // job before calling back in.
  if (emitter.step === 0) emitter.status("running")
  try {
    for (let step = emitter.step + 1; step <= maxSteps; step++) {
      if (signal.aborted || (await isCancelled())) {
        emitter.status("cancelled")
        return { kind: "settled" }
      }
      // Time-budget gate — before starting the next step, check whether
      // the surrounding function is close to its execution cap. The
      // caller persists the checkpoint and enqueues a `continue` job.
      if (shouldYield?.()) {
        return { kind: "yielded" }
      }
      emitter.startStep()
      const outcome = await runStep({ step, signal, emitter })
      emitter.endStep()
      if (outcome.pendingInput) {
        // Suspend without settling — the route persists the checkpoint
        // and emits the input request + `status: paused`.
        return { kind: "suspended", pendingInput: outcome.pendingInput }
      }
      if (outcome.done) {
        emitter.result("done")
        return { kind: "settled" }
      }
    }
    // Hit the step cap without a final answer. Settle anyway —
    // `finalText` falls back to the accumulated token text downstream.
    emitter.result("done")
    return { kind: "settled" }
  } catch (err) {
    if (signal.aborted) {
      emitter.status("cancelled")
      return { kind: "settled" }
    }
    emitter.result("failed", {
      error: err instanceof Error ? err.message : "Run failed",
    })
    return { kind: "settled" }
  }
}

// --------------------------------------------------------------------
// Token coalescer — exported for unit testing the boundary logic
// without driving a live model.
//
// The old in-Next `makeStreamTextStep` was deleted alongside
// `worker.ts`; the dedicated agent services own model invocation
// now and use their own step-fn implementations (see
// `services/agent-{ts,py}/`).
// --------------------------------------------------------------------

/**
 * Per-channel token buffer. `push` accumulates a delta and emits a
 * single coalesced `token` event once the buffer reaches `flushChars`;
 * switching channels flushes the other channel first so text/reasoning
 * stay correctly interleaved. Exposed for unit testing the boundary
 * logic without driving a live model. Only needs the emitter's `token`.
 */
export function makeTokenCoalescer(
  emitter: Pick<RunEmitter, "token">,
  flushChars: number
) {
  let textBuf = ""
  let reasoningBuf = ""
  const flush = (channel: "text" | "reasoning") => {
    if (channel === "text" && textBuf) {
      emitter.token(textBuf, "text")
      textBuf = ""
    } else if (channel === "reasoning" && reasoningBuf) {
      emitter.token(reasoningBuf, "reasoning")
      reasoningBuf = ""
    }
  }
  return {
    push(channel: "text" | "reasoning", delta: string) {
      if (!delta) return
      if (channel === "text") {
        flush("reasoning")
        textBuf += delta
        if (textBuf.length >= flushChars) flush("text")
      } else {
        flush("text")
        reasoningBuf += delta
        if (reasoningBuf.length >= flushChars) flush("reasoning")
      }
    },
    flushAll() {
      flush("text")
      flush("reasoning")
    },
  }
}

