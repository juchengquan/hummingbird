import "client-only"

/**
 * HTTP transport for agent-py's runs API (`packages/contract/openapi.yaml`
 * tag `runs`; wire rules in `packages/contract/RUN_EVENTS.md`). Exposed as
 * `apiClient.runs.*`.
 *
 * What it does that `@ag-ui/client`'s `HttpAgent` can't (Q37):
 * - tracks the replay cursor from each SSE `id:` (`RunStream.cursor`,
 *   `onCursor`);
 * - rejoins a run from a cursor (`rejoinRun`, `?after=` + `Last-Event-ID`)
 *   and, when a live stream breaks, reconnects by itself from the last
 *   cursor — the consumer sees one uninterrupted event sequence (the
 *   repeated `RUN_STARTED` of the reconnect is dropped);
 * - authenticates with the Supabase JWT when signed in, or with the run's
 *   `X-Run-Token` when anonymous — captured from the start response and
 *   kept per run (`run-tokens.ts`) so it survives a reload;
 * - status, cancel, and resume (a new run on the same thread answering
 *   the previous run's interrupts, Q24/Q35).
 *
 * Plain `fetch` + async iterables: no rxjs here, so importing the
 * transport costs nothing beyond this file. `agent.ts` wraps a
 * `RunStream` into the Observable `@ag-ui/client`'s pipeline consumes.
 *
 * Every function throws `RunsError` (and only that) on failure.
 */

import { START_CURSOR, compareCursors, isRunCursor } from "@/shared/runs/cursor"

import { RunsError, runsErrorFromResponse } from "./errors"
import { dropRunToken, loadRunToken, saveRunToken, type TokenStorage } from "./run-tokens"
import { SseParser } from "./sse"
import type {
  AgUiEvent,
  ResumeEntry,
  Run,
  RunCursor,
  RunsTarget,
  StartRunRequest,
} from "./types"

export interface RunRequestOptions {
  /** Where to send it — `resolveRunsTarget()`. */
  target: RunsTarget
  signal?: AbortSignal
  /** An anonymous run's token, overriding the stored one. */
  runToken?: string | null
  /** Token storage seam (tests); defaults to localStorage. */
  tokens?: TokenStorage | null
  /** `fetch` seam (tests); defaults to the global one. */
  fetch?: typeof fetch
}

export interface RunStreamOptions extends RunRequestOptions {
  /** Each new SSE id, as it arrives (persist it for rejoin-on-reload). */
  onCursor?: (cursor: RunCursor) => void
  /** Reconnect attempts after a broken stream before giving up with a
   *  `network` error (default 3; 0 disables). The count resets whenever the
   *  cursor advances. */
  maxReconnects?: number
  /** First reconnect delay; doubles per attempt, capped at 4 s (default 500 ms). */
  reconnectDelayMs?: number
}

/** One event of a run stream and its SSE id — `null` for the events that
 *  carry none (`RUN_STARTED`, a `gap`, a purged run's empty snapshot, the
 *  closing events; RUN_EVENTS.md § 6.1). */
export interface RunStreamItem {
  event: AgUiEvent
  cursor: RunCursor | null
}

/**
 * A run's event stream (start or rejoin), as an async iterable. Iterate
 * it once. It ends after the closing event (`RUN_FINISHED` / `RUN_ERROR`),
 * or throws a `RunsError`. Breaking out of the loop, or `close()`, drops
 * the connection — the run itself keeps going (cancel it with `cancelRun`).
 */
export interface RunStream extends AsyncIterable<RunStreamItem> {
  readonly runId: string
  /** The run's `X-Run-Token` (anonymous runs), else `null`. */
  readonly runToken: string | null
  /** The last SSE id received (`"0"`, or the rejoin's `after`, before any). */
  readonly cursor: RunCursor
  close(): void
}

/** `POST /v1/runs` for a resume (Q24): a new run on the interrupted run's
 *  thread whose `resume[]` answers every open interrupt. */
export interface ResumeRunRequest {
  /** The resume run's body — `buildRunInput(...)`, any `resume` /
   *  `forwardedProps.previousRunId` in it is replaced. */
  input: StartRunRequest
  /** The interrupted run being answered. */
  previousRunId: string
  /** One entry per open interrupt — `buildResume(...)` (`interrupts.ts`). */
  resume: ResumeEntry[]
}

const DEFAULT_RECONNECTS = 3
const DEFAULT_RECONNECT_DELAY_MS = 500
const MAX_RECONNECT_DELAY_MS = 4_000

function runsUrl(target: RunsTarget, path: string): string {
  return `${target.baseUrl}${path}`
}

function runPath(runId: string, suffix = ""): string {
  return `/v1/runs/${encodeURIComponent(runId)}${suffix}`
}

/** Auth headers: Bearer when signed in; otherwise the run's token, when
 *  one is known. */
function authHeaders(
  opts: RunRequestOptions,
  tokenRunId: string | null,
): { headers: Record<string, string>; token: string | null } {
  const headers: Record<string, string> = {}
  if (opts.target.authToken) {
    headers.Authorization = `Bearer ${opts.target.authToken}`
    return { headers, token: null }
  }
  const token =
    opts.runToken !== undefined
      ? opts.runToken
      : tokenRunId
        ? loadRunToken(tokenRunId, opts.tokens)
        : null
  if (token) headers["X-Run-Token"] = token
  return { headers, token }
}

function toRunsError(err: unknown, signal: AbortSignal | undefined): RunsError {
  if (err instanceof RunsError) return err
  if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
    return new RunsError("aborted", "aborted", "The request was aborted.")
  }
  return new RunsError(
    "network",
    "network",
    err instanceof Error && err.message ? err.message : "Network error.",
  )
}

async function send(
  opts: RunRequestOptions,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const doFetch = opts.fetch ?? globalThis.fetch
  try {
    return await doFetch(url, { ...init, signal })
  } catch (err) {
    throw toRunsError(err, signal)
  }
}

/** An AbortController that also aborts when `outer` does. */
function linkedController(outer: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (outer) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener("abort", () => controller.abort(), { once: true })
  }
  return controller
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RunsError("aborted", "aborted", "The request was aborted."))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new RunsError("aborted", "aborted", "The request was aborted."))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function* readSse(
  res: Response,
): AsyncGenerator<{ id?: string; data: string }, void, undefined> {
  if (!res.body) throw new RunsError("protocol", "invalid_response", "The run stream had no body.", res.status)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      for (const msg of parser.push(decoder.decode(value, { stream: true }))) yield msg
    }
    for (const msg of parser.push(decoder.decode())) yield msg
    parser.end()
  } finally {
    reader.releaseLock()
  }
}

function isTerminal(event: AgUiEvent): boolean {
  return event.type === "RUN_FINISHED" || event.type === "RUN_ERROR"
}

/** Whether a closing event ends the run for good (its token can go) —
 *  everything but an interrupt, whose answer presents the token. */
function endsForGood(event: AgUiEvent): boolean {
  if (event.type === "RUN_ERROR") return true
  if (event.type !== "RUN_FINISHED") return false
  const outcome = (event as { outcome?: { type?: unknown } }).outcome
  return outcome?.type !== "interrupt"
}

class HttpRunStream implements RunStream {
  readonly runId: string
  readonly runToken: string | null
  cursor: RunCursor
  private readonly controller: AbortController
  private readonly opts: RunStreamOptions
  private first: Response | null

  constructor(args: {
    runId: string
    runToken: string | null
    response: Response
    controller: AbortController
    opts: RunStreamOptions
    after: RunCursor
  }) {
    this.runId = args.runId
    this.runToken = args.runToken
    this.first = args.response
    this.controller = args.controller
    this.opts = args.opts
    this.cursor = args.after
  }

  close(): void {
    this.controller.abort()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RunStreamItem> {
    const first = this.first
    if (!first) throw new RunsError("protocol", "invalid_response", "A run stream is iterated once.")
    this.first = null
    const max = this.opts.maxReconnects ?? DEFAULT_RECONNECTS
    const baseDelay = this.opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    let res = first
    let sawStarted = false
    let ended = false
    let failures = 0
    try {
      while (true) {
        try {
          for await (const msg of readSse(res)) {
            let event: AgUiEvent
            try {
              event = JSON.parse(msg.data) as AgUiEvent
            } catch {
              throw new RunsError("protocol", "invalid_response", "A run stream frame was not JSON.")
            }
            if (!event || typeof event !== "object" || typeof event.type !== "string") {
              throw new RunsError("protocol", "invalid_response", "A run stream frame was not an event.")
            }
            if (msg.id !== undefined && isRunCursor(msg.id)) {
              // Ids strictly increase within a run's stream; one at or
              // before the cursor is a repeat from a reconnect.
              if (compareCursors(msg.id, this.cursor) <= 0) continue
              this.cursor = msg.id
              this.opts.onCursor?.(msg.id)
              failures = 0
            }
            // A reconnect (or a rejoin of a run already shown) opens with
            // RUN_STARTED again; the consumer has seen it (§ 6.1).
            if (event.type === "RUN_STARTED") {
              if (sawStarted) continue
              sawStarted = true
            }
            if (isTerminal(event)) {
              ended = true
              if (this.runToken && endsForGood(event)) dropRunToken(this.runId, this.opts.tokens)
            }
            yield { event, cursor: msg.id ?? null }
            if (ended) return
          }
          throw new RunsError("network", "network", "The run's stream ended before the run did.")
        } catch (err) {
          const e = toRunsError(err, this.controller.signal)
          if (e.kind !== "network" || failures >= max) throw e
          const delay = Math.min(baseDelay * 2 ** failures, MAX_RECONNECT_DELAY_MS)
          failures += 1
          await sleep(delay, this.controller.signal)
          res = await openEvents(this.runId, this.cursor, this.opts, this.controller, this.runToken)
        }
      }
    } finally {
      this.controller.abort()
    }
  }
}

async function expectStream(res: Response): Promise<void> {
  if (!res.ok) throw await runsErrorFromResponse(res)
  const type = res.headers.get("content-type") ?? ""
  if (!type.includes("text/event-stream")) {
    throw new RunsError(
      "protocol",
      "invalid_response",
      `Expected an event stream, got ${type || "no content type"}.`,
      res.status,
    )
  }
}

async function openEvents(
  runId: string,
  after: RunCursor,
  opts: RunStreamOptions,
  controller: AbortController,
  runToken: string | null,
): Promise<Response> {
  const { headers } = authHeaders({ ...opts, runToken: runToken ?? opts.runToken }, runId)
  headers.Accept = "text/event-stream"
  let url = runsUrl(opts.target, runPath(runId, "/events"))
  if (after !== START_CURSOR) {
    headers["Last-Event-ID"] = after
    url += `?after=${encodeURIComponent(after)}`
  }
  const res = await send(opts, url, { method: "GET", headers }, controller.signal)
  if (res.status === 404 && !opts.target.authToken) dropRunToken(runId, opts.tokens)
  await expectStream(res)
  return res
}

/**
 * Start an interactive run (`POST /v1/runs`, Q28) and return its stream.
 *
 * `body.runId` is the client-minted id; sending the same body again is an
 * idempotent retry (the stream replays from the start). Anonymous: the
 * response's `X-Run-Token` is stored for the run; a retry or a resume
 * presents the stored token. Background runs (`forwardedProps.mode:
 * "background"`, `202`) are not this function's job (the tasks panel,
 * Q38) — they're rejected before any request.
 */
export async function startRun(body: StartRunRequest, opts: RunStreamOptions): Promise<RunStream> {
  const mode = (body.forwardedProps as { mode?: unknown } | undefined)?.mode
  if (mode !== undefined && mode !== "interactive") {
    throw new RunsError("protocol", "invalid_request", "startRun streams interactive runs only.")
  }
  const controller = linkedController(opts.signal)
  const previousRunId = (body.forwardedProps as { previousRunId?: unknown } | undefined)
    ?.previousRunId
  // Anonymous: a retry presents this run's token; a resume the token of
  // the run it answers (it keeps that token).
  const tokenRunId =
    !opts.target.authToken && loadRunToken(body.runId, opts.tokens)
      ? body.runId
      : typeof previousRunId === "string"
        ? previousRunId
        : body.runId
  const { headers } = authHeaders(opts, tokenRunId)
  headers["Content-Type"] = "application/json"
  headers.Accept = "text/event-stream"
  const res = await send(
    opts,
    runsUrl(opts.target, "/v1/runs"),
    { method: "POST", headers, body: JSON.stringify(body) },
    controller.signal,
  )
  await expectStream(res)
  let runToken: string | null = null
  if (!opts.target.authToken) {
    runToken = res.headers.get("x-run-token")
    if (runToken) saveRunToken(body.runId, runToken, opts.tokens)
  }
  return new HttpRunStream({
    runId: body.runId,
    runToken,
    response: res,
    controller,
    opts,
    after: START_CURSOR,
  })
}

/**
 * Rejoin a run's stream (`GET /v1/runs/{id}/events`): replay after `after`
 * (default `"0"`, the whole run), then follow it live until it ends. The
 * server sends the cursor both as `?after=` and `Last-Event-ID`. A cursor
 * the log compacted away answers with a `gap` + `MESSAGES_SNAPSHOT`, which
 * the reducer turns into a reset.
 */
export async function rejoinRun(
  runId: string,
  opts: RunStreamOptions & { after?: RunCursor },
): Promise<RunStream> {
  const after = opts.after ?? START_CURSOR
  if (!isRunCursor(after)) throw new RunsError("protocol", "invalid_request", `Not a run cursor: ${after}`)
  const controller = linkedController(opts.signal)
  const runToken = opts.target.authToken ? null : (opts.runToken ?? loadRunToken(runId, opts.tokens))
  const res = await openEvents(runId, after, opts, controller, runToken)
  return new HttpRunStream({ runId, runToken, response: res, controller, opts, after })
}

/** Start the run answering an interrupted run's interrupts (Q24). */
export function resumeRun(request: ResumeRunRequest, opts: RunStreamOptions): Promise<RunStream> {
  const forwardedProps = {
    ...(request.input.forwardedProps ?? {}),
    previousRunId: request.previousRunId,
  }
  return startRun({ ...request.input, forwardedProps, resume: request.resume }, opts)
}

async function runJson(
  runId: string,
  suffix: string,
  method: "GET" | "POST",
  opts: RunRequestOptions,
): Promise<Run> {
  const { headers } = authHeaders(opts, runId)
  const res = await send(
    opts,
    runsUrl(opts.target, runPath(runId, suffix)),
    { method, headers },
    opts.signal,
  )
  if (!res.ok) {
    if (res.status === 404 && !opts.target.authToken) dropRunToken(runId, opts.tokens)
    throw await runsErrorFromResponse(res)
  }
  let run: Run
  try {
    run = (await res.json()) as Run
  } catch {
    throw new RunsError("protocol", "invalid_response", "The run response was not JSON.", res.status)
  }
  if (!run || typeof run !== "object" || typeof run.status !== "string") {
    throw new RunsError("protocol", "invalid_response", "The run response had no status.", res.status)
  }
  if (
    !opts.target.authToken &&
    (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled")
  ) {
    dropRunToken(runId, opts.tokens)
  }
  return run
}

/** The run resource (`GET /v1/runs/{id}`): status, open interrupts,
 *  result / error. 404 (unknown, someone else's, or an anonymous run the
 *  backend has forgotten) throws `RunsError { status: 404, code: "not_found" }`. */
export function getRun(runId: string, opts: RunRequestOptions): Promise<Run> {
  return runJson(runId, "", "GET", opts)
}

/** Cancel a run (`POST /v1/runs/{id}/cancel`, idempotent): a live stream
 *  of it then closes with `RUN_FINISHED { outcome: cancelled }`. An
 *  interrupted run's open interrupts are abandoned. Returns the run as it
 *  now stands. */
export function cancelRun(runId: string, opts: RunRequestOptions): Promise<Run> {
  return runJson(runId, "/cancel", "POST", opts)
}
