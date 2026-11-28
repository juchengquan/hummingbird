import "client-only"

/**
 * `@ag-ui/client` with our transport (Q37): an `AbstractAgent` whose
 * `run` / `connect` read a `RunStream` (`transport.ts`) instead of
 * `HttpAgent`'s request.
 *
 * Why a subclass rather than calling the pipeline functions by hand: the
 * agent's `runAgent` / `connectAgent` are where `@ag-ui/client` composes its
 * event checks — the inbound compatibility boundary, `enforceEvents`
 * (schema), `transformChunks`, `verifyEvents` (ordering: one RUN_STARTED,
 * messages and tool calls opened before content and closed before the
 * run ends, nothing after the end) — with its state handling
 * (`defaultApplyEvents`: the run's AG-UI messages, `pendingInterrupts`,
 * and the resume-coverage check in `onInitialize`). Re-assembling that
 * pipeline from its exported pieces would copy private wiring that
 * changes between releases; subclassing uses it as published. What
 * `HttpAgent` can't do — cursor tracking, rejoin, reconnects, run tokens —
 * stays in the transport, below `run()`.
 *
 * The agent holds only this run's output in `messages` (never the
 * conversation history): a rejoin's `MESSAGES_SNAPSHOT` is this run's
 * output only (RUN_EVENTS.md § 6.3), and AG-UI applies a snapshot as the
 * whole message list. The request body is built by `buildRunInput` and
 * sent verbatim (`prepareRunAgentInput` is overridden), so the history the
 * backend sees is exactly the store's, text-only (Q15/Q32).
 *
 * One agent per run session (`session.ts`); not reused across runs.
 */

import { AbstractAgent, type RunAgentInput, type RunAgentParameters } from "@ag-ui/client"
import { Observable } from "rxjs"

import type { RunStream, RunStreamItem } from "./transport"
import type { AgUiEvent, StartRunRequest } from "./types"

export interface RunAgentTransport {
  /** Open the stream of a new run (`startRun` / `resumeRun`) for `body`. */
  start(body: StartRunRequest): Promise<RunStream>
  /** Open the stream of an existing run (`rejoinRun`). */
  rejoin(): Promise<RunStream>
  /**
   * Each item once `@ag-ui/client` accepted its event: called right after
   * the event went through the agent's checks (`enforceEvents` →
   * `verifyEvents` run synchronously inside `next`), with its SSE cursor,
   * and never for an event they rejected (the pipeline errors and closes
   * the subscription first). This is where the session feeds the reducer.
   */
  onVerified?(item: RunStreamItem): void
}

/** An Observable over a run stream: opened on subscribe, closed (the
 *  connection dropped) on unsubscribe — e.g. `detachActiveRun()`. */
export function observeRunStream(
  open: () => Promise<RunStream>,
  onVerified?: (item: RunStreamItem) => void,
): Observable<AgUiEvent> {
  return new Observable<AgUiEvent>((subscriber) => {
    let stream: RunStream | null = null
    let closed = false
    void (async () => {
      try {
        stream = await open()
        if (closed) {
          stream.close()
          return
        }
        for await (const item of stream) {
          if (closed) break
          subscriber.next(item.event)
          if (closed || subscriber.closed) break
          onVerified?.(item)
        }
        subscriber.complete()
      } catch (err) {
        if (!closed) subscriber.error(err)
      }
    })()
    return () => {
      closed = true
      stream?.close()
    }
  })
}

export class HummingbirdRunAgent extends AbstractAgent {
  private readonly transport: RunAgentTransport
  private body: StartRunRequest | null = null

  constructor(transport: RunAgentTransport, threadId: string) {
    super({ threadId, initialMessages: [] })
    this.transport = transport
  }

  /** Send `body` verbatim as the next `runAgent()`'s request. */
  setRequest(body: StartRunRequest): void {
    this.body = body
    this.threadId = body.threadId
  }

  protected prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput {
    return this.body ? (this.body as RunAgentInput) : super.prepareRunAgentInput(parameters)
  }

  run(input: RunAgentInput): Observable<AgUiEvent> {
    return observeRunStream(
      () => this.transport.start(input as StartRunRequest),
      this.transport.onVerified,
    )
  }

  protected connect(): Observable<AgUiEvent> {
    return observeRunStream(() => this.transport.rejoin(), this.transport.onVerified)
  }

  clone(): HummingbirdRunAgent {
    const copy = new HummingbirdRunAgent(this.transport, this.threadId)
    copy.body = this.body
    return copy
  }
}
