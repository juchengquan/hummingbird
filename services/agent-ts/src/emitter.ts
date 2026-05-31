/**
 * RunEmitter — direct port of
 * `services/agent-py/src/agent_py/emitter.py`.
 *
 * One per run. Owns the monotonic `seq` counter + the "settled-once"
 * guard so a buggy step fn can't emit two `result` events for the
 * same run. Persistence is injected via `EventSink` so tests can swap
 * a buffer; production wires `sink = (e) => appendEvent(sql, e, userId)`.
 */

import type {
  RunStatus,
  TaskEvent,
  ToolCallResult,
} from "./events"
import { isTerminalStatus } from "./events"

export type EventSink = (event: TaskEvent) => Promise<void>

export interface RunEmitterOptions {
  runId: string
  sink: EventSink
  /** Resume seed. Phase 3a passes the checkpoint's saved `seq` so
   *  re-tailed events follow the originals monotonically. */
  startSeq?: number
  /** Same idea for `step`. */
  startStep?: number
}

export class RunEmitter {
  readonly runId: string
  private readonly sink: EventSink
  private _seq: number
  private _step: number
  private _settled = false
  private _statusEmitted = false

  constructor({ runId, sink, startSeq = 0, startStep = 0 }: RunEmitterOptions) {
    this.runId = runId
    this.sink = sink
    this._seq = startSeq
    this._step = startStep
  }

  /** Current `seq` (the next emit's seq number). */
  get seq(): number {
    return this._seq
  }

  /** Current `step`. */
  get step(): number {
    return this._step
  }

  /** True once `result` has fired. Subsequent emits no-op. */
  get settled(): boolean {
    return this._settled
  }

  /** Stamp the run with a non-terminal status (`running` / `paused`).
   *  Terminal statuses go through `result(...)`. */
  async status(status: RunStatus): Promise<void> {
    if (this._settled) return
    if (isTerminalStatus(status)) {
      throw new Error(
        `emitter.status: terminal status "${status}" must use emitter.result(...)`,
      )
    }
    await this.emit({ kind: "status", status })
    this._statusEmitted = true
  }

  /** Mark the start of one step. Increments `step` first so emitted
   *  rows carry the new step number. */
  async stepStart(): Promise<void> {
    if (this._settled) return
    this._step += 1
    await this.emit({ kind: "step_start" })
  }

  async stepEnd(): Promise<void> {
    if (this._settled) return
    await this.emit({ kind: "step_end" })
  }

  async token(text: string, channel: "text" | "reasoning" = "text"): Promise<void> {
    if (this._settled || text === "") return
    await this.emit({ kind: "token", text, channel })
  }

  async toolInput(args: {
    toolCallId: string
    toolName: string
    args: Record<string, unknown>
  }): Promise<void> {
    if (this._settled) return
    await this.emit({ kind: "tool_input", ...args })
  }

  async toolOutput(args: {
    toolCallId: string
    toolName: string
    summary: string
    results?: ToolCallResult[]
  }): Promise<void> {
    if (this._settled) return
    await this.emit({ kind: "tool_output", ...args })
  }

  async stepError(message: string, willRetry = true): Promise<void> {
    if (this._settled) return
    await this.emit({ kind: "step_error", message, willRetry })
  }

  /** Final emit. Subsequent emits no-op. */
  async result(
    status: "done" | "failed",
    extra: { finalText?: string; error?: string } = {},
  ): Promise<void> {
    if (this._settled) return
    await this.emit({ kind: "result", status, ...extra })
    this._settled = true
  }

  /** Helper for the runner: emit `status: running` exactly once at
   *  the start of a fresh run. Idempotent. */
  async ensureRunning(): Promise<void> {
    if (this._settled || this._statusEmitted) return
    await this.status("running")
  }

  // --- internals -------------------------------------------------------

  // TS can't track the discriminant correlation through
  // `Omit<TaskEvent, "runId" | "seq" | "step" | "createdAt">`, so the
  // emit helper takes the kind-specific bag as `Record<string, unknown>`
  // and we cast the assembled object at the boundary. Internal-only;
  // every caller (the per-kind methods above) already validates the
  // shape against the typed `TaskEvent` union.
  private async emit(partial: Record<string, unknown>): Promise<void> {
    const event = {
      ...partial,
      runId: this.runId,
      seq: this._seq,
      step: this._step,
      createdAt: new Date().toISOString(),
    } as TaskEvent
    this._seq += 1
    await this.sink(event)
  }
}
