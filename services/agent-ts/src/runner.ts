/**
 * Agent loop — direct port of
 * `services/agent-py/src/agent_py/runner.py`.
 *
 * Pure orchestration: the step fn is injected so tests can pass a
 * fake, the executor (Phase 2) passes a stub that emits two canned
 * tokens, and Phase 3 lands the real Anthropic-streaming step fn.
 *
 * Loop contract:
 *   - Auto-emit `status: running` once at step 0 (idempotent via
 *     `RunEmitter.ensureRunning`).
 *   - For each step: `step_start` → run the step fn → `step_end`.
 *   - Between steps poll `isCancelled()` + `shouldYield()`.
 *     Cancelled → emit `result: failed (cancelled)` + return kind
 *     `"cancelled"`. Yielded → return kind `"yielded"` so the
 *     executor can persist the checkpoint + enqueue a `continue`
 *     job.
 *   - Step fn returns `RunStepOutcome.done = true` → emit
 *     `result: done` + return kind `"settled"`.
 *   - Step fn throws → emit `result: failed (error)` + return kind
 *     `"settled"`.
 *   - Reach `maxSteps` without settling → emit
 *     `result: failed (max_steps)` + return kind `"settled"`.
 */

import type { RunEmitter } from "./emitter"

/** What a step fn receives. */
export interface RunStepContext {
  emitter: RunEmitter
}

/** What a step fn returns. */
export interface RunStepOutcome {
  /** True when the model produced a text-only final answer. */
  done: boolean
}

export type RunStepFn = (ctx: RunStepContext) => Promise<RunStepOutcome>

export type AgentLoopResultKind = "settled" | "cancelled" | "yielded"

export interface AgentLoopResult {
  kind: AgentLoopResultKind
}

export interface RunAgentLoopOptions {
  emitter: RunEmitter
  maxSteps: number
  runStep: RunStepFn
  isCancelled: () => Promise<boolean>
  /** Optional chunk-break check polled between steps. Return true to
   *  yield + persist checkpoint. */
  shouldYield?: () => boolean
}

export async function runAgentLoop({
  emitter,
  maxSteps,
  runStep,
  isCancelled,
  shouldYield,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  await emitter.ensureRunning()

  for (let step = 0; step < maxSteps; step += 1) {
    if (await isCancelled()) {
      await emitter.result("failed", { error: "cancelled" })
      return { kind: "cancelled" }
    }

    if (shouldYield?.()) {
      return { kind: "yielded" }
    }

    await emitter.stepStart()
    let outcome: RunStepOutcome
    try {
      outcome = await runStep({ emitter })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await emitter.result("failed", { error: message })
      return { kind: "settled" }
    }
    await emitter.stepEnd()

    if (outcome.done) {
      await emitter.result("done")
      return { kind: "settled" }
    }
  }

  await emitter.result("failed", { error: `exceeded max_steps=${maxSteps}` })
  return { kind: "settled" }
}
