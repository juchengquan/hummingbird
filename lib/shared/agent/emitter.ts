/**
 * The producer side of the agent event model (`./events.ts` is the IR,
 * `./project.ts` is the consumer). A runner drives a `RunEmitter` to
 * emit a well-formed `TaskEvent` log; the emitter owns the invariants
 * that a hand-built log could get wrong:
 *
 *  - `seq` is strictly monotonic from 1 (the resume cursor).
 *  - `step` starts at 0 and only advances via `startStep()`.
 *  - the run settles exactly once: after `result()` (or a terminal
 *    `status()`), further emits are dropped, so a late tool callback
 *    can't append past the end of a finished run.
 *
 * Events go to a `sink` the caller supplies — in production the runner
 * wires a sink that both persists to `task_events` and pushes onto the
 * wire stream; in tests the sink collects into an array. Pure: no I/O
 * here, just object construction + counter bookkeeping (the clock is
 * injectable for deterministic tests).
 */

import {
  isTerminalStatus,
  type PlanItem,
  type RunStatus,
  type TaskEvent,
} from "./events"
import type { ToolCallResult } from "@/shared/types"

export type TaskEventSink = (event: TaskEvent) => void

/** `Omit` collapses a discriminated union to its common keys; this
 *  distributes the omit across each member so per-kind payload fields
 *  survive. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

/** A `TaskEvent` minus the base fields the emitter fills in. */
type TaskEventBody = DistributiveOmit<
  TaskEvent,
  "runId" | "seq" | "step" | "createdAt"
>

export interface RunEmitterOptions {
  runId: string
  /** Step ceiling carried on the first `status` event for an "N / M"
   *  progress display. */
  maxSteps?: number
  /** Injectable clock — defaults to `Date.now`-based ISO. */
  now?: () => string
}

export class RunEmitter {
  private seqCounter = 0
  private stepCounter = 0
  private isSettled = false
  private readonly runId: string
  private readonly maxSteps: number | undefined
  private readonly clock: () => string
  private readonly sink: TaskEventSink

  constructor(options: RunEmitterOptions, sink: TaskEventSink) {
    this.runId = options.runId
    this.maxSteps = options.maxSteps
    this.clock = options.now ?? (() => new Date().toISOString())
    this.sink = sink
  }

  /** True once the run has emitted a terminal event. Further emits
   *  are no-ops. */
  get settled(): boolean {
    return this.isSettled
  }

  /** Current step number (0 before the first `startStep`). */
  get step(): number {
    return this.stepCounter
  }

  // --- lifecycle -----------------------------------------------------

  status(status: RunStatus): void {
    this.emit({
      kind: "status",
      status,
      ...(this.maxSteps !== undefined ? { maxSteps: this.maxSteps } : {}),
    })
    // A terminal status (e.g. `cancelled`) settles the run just like
    // `result` — nothing should follow it.
    if (isTerminalStatus(status)) this.isSettled = true
  }

  /** Advance to the next step and emit its boundary. Returns the new
   *  step number. */
  startStep(): number {
    this.stepCounter += 1
    this.emit({ kind: "step_start" })
    return this.stepCounter
  }

  endStep(): void {
    this.emit({ kind: "step_end" })
  }

  // --- content -------------------------------------------------------

  token(text: string, channel: "text" | "reasoning" = "text"): void {
    this.emit(
      channel === "reasoning"
        ? { kind: "token", text, channel: "reasoning" }
        : { kind: "token", text }
    )
  }

  toolInput(toolCallId: string, toolName: string, args: unknown): void {
    this.emit({ kind: "tool_input", toolCallId, toolName, args })
  }

  toolOutput(
    toolCallId: string,
    toolName: string,
    summary: string,
    results?: ToolCallResult[]
  ): void {
    this.emit({
      kind: "tool_output",
      toolCallId,
      toolName,
      summary,
      ...(results ? { results } : {}),
    })
  }

  plan(items: PlanItem[]): void {
    this.emit({ kind: "plan", items })
  }

  stepError(message: string, willRetry: boolean): void {
    this.emit({ kind: "step_error", message, willRetry })
  }

  artifactRef(artifactId: string): void {
    this.emit({ kind: "artifact_ref", artifactId })
  }

  // --- terminal ------------------------------------------------------

  /** Settle the run. `finalText` defaults to undefined (the consumer
   *  falls back to the accumulated token text). After this, the
   *  emitter is inert. */
  result(
    status: "done" | "failed",
    opts?: { finalText?: string; error?: string }
  ): void {
    this.emit({
      kind: "result",
      status,
      ...(opts?.finalText !== undefined ? { finalText: opts.finalText } : {}),
      ...(opts?.error !== undefined ? { error: opts.error } : {}),
    })
    this.isSettled = true
  }

  // --- internals -----------------------------------------------------

  /** Build the base fields, advance `seq`, and hand to the sink.
   *  Drops everything once settled. */
  private emit(body: TaskEventBody): void {
    if (this.isSettled) return
    this.seqCounter += 1
    const event = {
      runId: this.runId,
      seq: this.seqCounter,
      step: this.stepCounter,
      createdAt: this.clock(),
      ...body,
    } as TaskEvent
    this.sink(event)
  }
}
