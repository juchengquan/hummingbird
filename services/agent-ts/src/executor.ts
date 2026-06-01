/**
 * Executor — direct port of
 * `services/agent-py/src/agent_py/executor.py` (Phase 2a slice).
 *
 * Wires `claim → runAgentLoop → settle`. The poller hands a claimed
 * `start` job here; this module:
 *
 *   1. Stamps `tasks.metadata.handler = 'agent-ts'` for postmortem audit.
 *   2. Loads the run's checkpoint, builds the step fn (Phase 2a uses
 *      a stub that emits two canned tokens; Phase 3 wires
 *      `makeAnthropicStepFn`).
 *   3. Builds a `RunEmitter` whose sink persists into `task_events`.
 *   4. Calls `runAgentLoop` with the step fn.
 *   5. Updates `tasks` to a terminal status on settle.
 *
 * `makeStepFn` is the injection seam — tests pass a fake, production
 * defaults to `defaultMakeStepFn` which routes to the stub for now.
 */

import type { Sql } from "./db"
import { RunEmitter } from "./emitter"
import type { TaskEvent } from "./events"
import type { RunStepContext, RunStepFn } from "./runner"
import { runAgentLoop } from "./runner"
import {
  appendEvent,
  isRunCancelled,
  loadCheckpoint,
  setTaskHandler,
  updateRun,
} from "./store"

const HANDLER_NAME = "agent-ts"

export interface StartActionPayload {
  runId: string
  userId: string
  /** Fallback when `checkpoint.config.maxSteps` is missing. The TS
   *  chat route always writes maxSteps; this matters mostly for
   *  tests / dev seeds. */
  maxSteps?: number
}

export interface ExecutorOutcome {
  settled: boolean
  error?: string
}

export type MakeStepFn = (
  payload: StartActionPayload,
  checkpoint: Record<string, unknown>,
) => RunStepFn

export interface ExecuteStartOptions {
  makeStepFn?: MakeStepFn
}

/** Run a `start` action end-to-end. */
export async function executeStart(
  sql: Sql,
  payload: StartActionPayload,
  options: ExecuteStartOptions = {},
): Promise<ExecutorOutcome> {
  const checkpoint = (await loadCheckpoint(sql, payload.runId, payload.userId)) ?? {}

  const sink = makeDbSink(sql, payload.userId)
  const emitter = new RunEmitter({ runId: payload.runId, sink })

  try {
    await setTaskHandler(sql, payload.runId, payload.userId, HANDLER_NAME)

    const makeStep = options.makeStepFn ?? defaultMakeStepFn
    const stepFn = makeStep(payload, checkpoint)

    const maxSteps = maxStepsFrom(checkpoint, payload.maxSteps ?? 25)

    const result = await runAgentLoop({
      emitter,
      maxSteps,
      runStep: stepFn,
      isCancelled: () => isRunCancelled(sql, payload.runId, payload.userId),
    })

    if (result.kind === "cancelled") {
      await updateRun(sql, {
        runId: payload.runId,
        userId: payload.userId,
        status: "cancelled",
        finished: true,
      })
    } else {
      await updateRun(sql, {
        runId: payload.runId,
        userId: payload.userId,
        status: "done",
        step: emitter.step,
        finished: true,
      })
    }
    return { settled: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.warn(`[agent-ts.executor] failed run=${payload.runId}: ${message}`)
    try {
      if (!emitter.settled) {
        await emitter.result("failed", { error: message })
      }
      await updateRun(sql, {
        runId: payload.runId,
        userId: payload.userId,
        status: "failed",
        finished: true,
      })
    } catch {
      // Even cleanup failing is non-fatal; the job-fail path in the
      // poller will leave the row recoverable.
    }
    return { settled: false, error: message }
  }
}

// --- internals ----------------------------------------------------------

function makeDbSink(sql: Sql, userId: string) {
  return async (event: TaskEvent): Promise<void> => {
    await appendEvent(sql, event, userId)
  }
}

function maxStepsFrom(checkpoint: Record<string, unknown>, fallback: number): number {
  const cfg = checkpoint.config
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const raw = (cfg as Record<string, unknown>).maxSteps
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
      return raw
    }
  }
  return fallback
}

/**
 * Default step fn for Phase 2a — the stub. Two canned tokens + done.
 * Mirrors agent-py's `_stub_step_fn`. Phase 3 swaps in
 * `makeAnthropicStepFn`.
 */
function defaultMakeStepFn(): RunStepFn {
  return async (ctx: RunStepContext) => {
    await ctx.emitter.token("Phase 2a stub: ")
    await ctx.emitter.token("(set ANTHROPIC_API_KEY to enable real model streaming)")
    return { done: true }
  }
}
