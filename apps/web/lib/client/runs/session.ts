import "client-only"

/**
 * A run session: one run's stream, from start / rejoin / resume to its
 * end, driven through `@ag-ui/client` (`agent.ts`) and folded by the
 * reducer (`reducer.ts`) into ops for a `RunSink` — the seam wave 4b-A
 * implements on top of `use-chat-send`'s existing per-frame handling.
 *
 * ```
 * transport (RunStream: SSE, cursor, reconnect, run token)
 *   → HummingbirdRunAgent (enforce → verify → apply)      @ag-ui/client
 *   → onVerified(item)  → reduceRunEvent → ops → RunSink   ours
 * ```
 *
 * Contract:
 * - `done` always resolves (never rejects) with the outcome — `success`,
 *   `interrupt`, `cancelled`, or `error` (a run failure, an HTTP error of
 *   the start / rejoin request, a broken stream after the reconnects, or a
 *   stream `@ag-ui/client` rejected) — or `outcome: null` when the session
 *   was detached (the run goes on server-side; rejoin it later).
 * - The sink only sees `frame` / `reset` ops. A rewind is handled here; the
 *   outcome comes through `done`.
 * - `cancel()` is Stop (Q36): it cancels the run on the server and the
 *   stream ends with `cancelled`. If the cancel request fails the session
 *   detaches instead (the UI stops either way) and `cancel()` reports why.
 */

import type { AgentStateMutation, AgentSubscriber } from "@ag-ui/client"

import type { NormalisedFrame } from "@/client/chat/sse-frame-translator"
import { START_CURSOR, compareCursors, cursorSeq } from "@/shared/runs/cursor"

import { HummingbirdRunAgent } from "./agent"
import { RunsError, isRunsError } from "./errors"
import { buildResume, type InterruptAnswer, type PendingInterrupt } from "./interrupts"
import type { TokenStorage } from "./run-tokens"
import {
  framesFromView,
  initialRunTurnState,
  reduceRunEvent,
  type RunOutcome,
  type RunTurnOp,
  type RunTurnState,
} from "./reducer"
import {
  cancelRun,
  rejoinRun,
  startRun,
  type RunStream,
  type RunStreamItem,
  type RunStreamOptions,
} from "./transport"
import type { AgUiMessage, RunCursor, RunsTarget, StartRunRequest } from "./types"

/** Where a session's store updates go — one assistant message. */
export interface RunSink {
  /** Apply one frame exactly as a `/v1/chat` frame is applied to the
   *  placeholder today (text / reasoning / tool_call / tool_result / parts). */
  frame(frame: NormalisedFrame): void
  /** Clear the placeholder's run output (content, reasoning, tool calls,
   *  parts — not its id or position) before a reset's frames. */
  clear(): void
}

/** Apply `frame` / `reset` ops to a sink (`rewind` / `finished` are the
 *  session's). */
export function applyRunOps(sink: RunSink, ops: readonly RunTurnOp[]): void {
  for (const op of ops) {
    if (op.type === "frame") sink.frame(op.frame)
    else if (op.type === "reset") {
      sink.clear()
      for (const f of op.frames) sink.frame(f)
    }
  }
}

export interface RunSessionOptions {
  target: RunsTarget
  sink: RunSink
  /** The run's first event arrived (`RUN_STARTED`) — save the active-run
   *  pointer here. `runToken` is set for an anonymous run. */
  onStarted?(info: { runId: string; threadId: string; runToken: string | null }): void
  /** Each new SSE cursor — throttle and persist it on the pointer. */
  onCursor?(cursor: RunCursor): void
  /** Transport seams / tuning (tests). */
  tokens?: TokenStorage | null
  fetch?: typeof fetch
  maxReconnects?: number
  reconnectDelayMs?: number
}

export interface RunSessionResult {
  /** How the run ended; `null` when the session was detached. */
  outcome: RunOutcome | null
  /** The final fold: `state.view` is the run's output (`hasOutput`). */
  state: RunTurnState
  /** `@ag-ui/client`'s messages for the run (its apply state). */
  messages: AgUiMessage[]
  /** The last cursor received. */
  cursor: RunCursor
}

export interface RunSession {
  readonly runId: string
  readonly threadId: string
  readonly done: Promise<RunSessionResult>
  /** Stop: cancel the run on the server (see the module doc). */
  cancel(): Promise<{ ok: true } | { ok: false; error: RunsError }>
  /** Stop reading; the run continues server-side. */
  detach(): void
}

type Opener =
  | { kind: "start"; body: StartRunRequest; interrupts?: PendingInterrupt[] }
  | { kind: "rejoin"; quietUntil: RunCursor }

function errorOutcome(err: unknown): RunOutcome {
  const e = isRunsError(err)
    ? err
    : new RunsError(
        "protocol",
        "invalid_response",
        err instanceof Error ? err.message : "The run stream could not be read.",
      )
  return { type: "error", code: e.code, message: e.message, error: e.toMessageError() }
}

function createSession(
  runId: string,
  threadId: string,
  opener: Opener,
  opts: RunSessionOptions,
): RunSession {
  let state = initialRunTurnState()
  let cursor: RunCursor = START_CURSOR
  let quietUntil: RunCursor | null = opener.kind === "rejoin" ? opener.quietUntil : null
  let maxSeqSeen = 0
  let started = false
  let detached = false
  let restart: RunCursor | null = null
  let agent: HummingbirdRunAgent | null = null
  let failure: unknown = null
  let streamToken: string | null = null
  let resolveOpened: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    resolveOpened = resolve
  })

  const streamOpts = (): RunStreamOptions => ({
    target: opts.target,
    tokens: opts.tokens,
    fetch: opts.fetch,
    maxReconnects: opts.maxReconnects,
    reconnectDelayMs: opts.reconnectDelayMs,
    onCursor: (c) => {
      cursor = c
      opts.onCursor?.(c)
    },
  })

  const opened$ = (stream: Promise<RunStream>): Promise<RunStream> =>
    stream.then(
      (s) => {
        streamToken = s.runToken
        resolveOpened()
        return s
      },
      (err) => {
        resolveOpened()
        throw err
      },
    )

  const onVerified = (item: RunStreamItem): void => {
    if (restart !== null) return
    const { event } = item
    if (event.type === "RUN_STARTED" && !started) {
      started = true
      opts.onStarted?.({ runId, threadId, runToken: streamToken })
    }
    const step = reduceRunEvent(state, event)
    state = step.state
    let ops = step.ops
    const rewind = ops.find((o) => o.type === "rewind")
    if (rewind && rewind.type === "rewind" && maxSeqSeen > rewind.after) {
      // The dead attempt's events are on screen: replay the run from the
      // start (superseded entries are dropped server-side) and reset the
      // message once the replay passes this marker.
      restart = item.cursor ?? cursor
      void agent?.detachActiveRun()
      return
    }
    if (item.cursor) maxSeqSeen = Math.max(maxSeqSeen, cursorSeq(item.cursor))
    if (quietUntil !== null) {
      const terminal = ops.some((o) => o.type === "finished")
      const past = item.cursor !== null && compareCursors(item.cursor, quietUntil) > 0
      if (!terminal && !past) return
      // Caught up: one reset carries everything folded so far, this event
      // included; the event's own frames are already in the view.
      quietUntil = null
      ops = [{ type: "reset", frames: framesFromView(state.view) }, ...ops.filter((o) => o.type === "finished")]
    }
    applyRunOps(opts.sink, ops)
  }

  const runOnce = async (o: Opener): Promise<AgUiMessage[]> => {
    const a = new HummingbirdRunAgent(
      {
        start: (body) => opened$(startRun(body, streamOpts())),
        rejoin: () => opened$(rejoinRun(runId, { ...streamOpts(), after: START_CURSOR })),
        onVerified,
      },
      threadId,
    )
    agent = a
    const subscriber: AgentSubscriber = {
      onRunFailed: ({ error }) => {
        failure = error
        // Handled here (`done`): `stopPropagation` keeps @ag-ui/client from
        // logging and rethrowing it (its `onError` honours the flag; the
        // subscriber type omits it).
        return { stopPropagation: true } as Omit<AgentStateMutation, "stopPropagation">
      },
    }
    if (o.kind === "start") {
      if (o.interrupts) a.pendingInterrupts = o.interrupts.map((i) => i.raw)
      a.setRequest(o.body)
      await a.runAgent({ runId }, subscriber)
    } else {
      await a.connectAgent({ runId }, subscriber)
    }
    return a.messages
  }

  const done = (async (): Promise<RunSessionResult> => {
    let messages: AgUiMessage[] = []
    let o: Opener = opener
    try {
      while (true) {
        failure = null
        try {
          messages = await runOnce(o)
        } catch (err) {
          failure = err
        }
        if (restart !== null && !detached && !failure) {
          // Rewind: replay from the start, quiet until the marker.
          quietUntil = restart
          restart = null
          state = initialRunTurnState()
          maxSeqSeen = 0
          o = { kind: "rejoin", quietUntil }
          continue
        }
        break
      }
    } finally {
      resolveOpened()
    }
    if (detached) return { outcome: null, state, messages, cursor }
    if (failure) {
      if (isRunsError(failure) && failure.kind === "aborted") {
        return { outcome: null, state, messages, cursor }
      }
      const outcome = errorOutcome(failure)
      state = { ...state, outcome }
      return { outcome, state, messages, cursor }
    }
    if (!state.outcome) {
      const outcome = errorOutcome(
        new RunsError("protocol", "invalid_response", "The run stream ended without a result."),
      )
      state = { ...state, outcome }
    }
    return { outcome: state.outcome, state, messages, cursor }
  })()

  return {
    runId,
    threadId,
    done,
    async cancel() {
      await opened
      try {
        await cancelRun(runId, {
          target: opts.target,
          tokens: opts.tokens,
          fetch: opts.fetch,
          runToken: streamToken ?? undefined,
        })
        return { ok: true as const }
      } catch (err) {
        detached = true
        void agent?.detachActiveRun()
        return {
          ok: false as const,
          error: isRunsError(err) ? err : new RunsError("network", "network", String(err)),
        }
      }
    },
    detach() {
      detached = true
      void agent?.detachActiveRun()
    },
  }
}

/**
 * Start a run — the request body from `buildRunInput`. Its `runId` is the
 * session's; start a new session with the same body to retry it
 * idempotently (e.g. after a `network` outcome before any output).
 */
export function startRunSession(body: StartRunRequest, opts: RunSessionOptions): RunSession {
  return createSession(body.runId, body.threadId, { kind: "start", body }, opts)
}

/**
 * Rejoin a run after a reload (Q36). Always replays from `"0"` and folds
 * quietly until `quietUntil` (the pointer's saved cursor; default `"0"`),
 * then emits **one** `reset` carrying the whole output so far and goes on
 * live. Replaying instead of resuming at the cursor keeps the message
 * exact: the persisted message and the saved cursor are written at
 * different times, so resuming at the cursor could repeat or drop text.
 */
export function rejoinRunSession(
  run: { runId: string; threadId: string; quietUntil?: RunCursor },
  opts: RunSessionOptions,
): RunSession {
  return createSession(
    run.runId,
    run.threadId,
    { kind: "rejoin", quietUntil: run.quietUntil ?? START_CURSOR },
    opts,
  )
}

/**
 * Answer an interrupted run (Q24/Q35): a new run on the same thread with
 * `resume[]` answering every open interrupt. `input` is a fresh
 * `buildRunInput(...)` for the same conversation (new `runId`); its
 * `previousRunId` / `resume` are set here. `@ag-ui/client` re-checks that
 * every interrupt is answered (and none expired) before anything is sent.
 * The resume run's stream opens with one `tool_result` per answer — for
 * calls the interrupted run started, so a sink continuing the same
 * assistant message must still hold them (see README).
 */
export function resumeRunSession(
  request: {
    input: StartRunRequest
    previousRunId: string
    interrupts: readonly PendingInterrupt[]
    answers: Readonly<Record<string, InterruptAnswer>>
  },
  opts: RunSessionOptions,
): RunSession {
  const resume = buildResume(request.interrupts, request.answers)
  const body: StartRunRequest = {
    ...request.input,
    forwardedProps: { ...(request.input.forwardedProps ?? {}), previousRunId: request.previousRunId },
    resume,
  }
  return createSession(
    body.runId,
    body.threadId,
    { kind: "start", body, interrupts: [...request.interrupts] },
    opts,
  )
}
