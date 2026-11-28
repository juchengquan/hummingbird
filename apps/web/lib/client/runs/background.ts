import "client-only"

/**
 * agent-py's runs API for **background** runs — the tasks panel (wave 6,
 * Q69–Q77; `packages/contract/openapi.yaml` tag `runs`, RUN_EVENTS.md
 * § 4.4–4.5). Exposed as `apiClient.runs.{startBackground,
 * resumeBackground, list, answer, markDelivered}`.
 *
 * Background runs are signed-in only: every call sends the session's
 * bearer (read fresh per request, and refreshed once on a `401`, through
 * the target's `getAuthToken` — `sendAuthed`). Following a run's events is
 * `rejoinRun` (`transport.ts`), as for chat.
 *
 * Every function throws `RunsError` (and only that) on failure.
 */

import { RunsError, runsErrorFromResponse } from "./errors"
import { runPath, runsUrl, sendAuthed, type RunRequestOptions } from "./transport"
import type {
  AnswerRunRequest,
  ListRunsQuery,
  ResumeEntry,
  Run,
  RunList,
  RunStatus,
  StartRunRequest,
} from "./types"

/** `202 RunAccepted`. */
export interface BackgroundRunAccepted {
  runId: string
  status: RunStatus
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  try {
    return (await res.json()) as T
  } catch {
    throw new RunsError("protocol", "invalid_response", `The ${what} response was not JSON.`, res.status)
  }
}

function modeOf(body: StartRunRequest): unknown {
  return (body.forwardedProps as { mode?: unknown } | undefined)?.mode
}

/**
 * Start a background run (`POST /v1/runs`, `forwardedProps.mode:
 * "background"`) → `202 { runId, status }`. `body.runId` is client-minted:
 * sending the same body again is an idempotent retry (`202` with the run's
 * status), so a caller that lost the response sends it again with the same
 * id (the tasks controller keeps it before the first POST).
 */
export async function startBackgroundRun(
  body: StartRunRequest,
  opts: RunRequestOptions,
): Promise<BackgroundRunAccepted> {
  if (modeOf(body) !== "background") {
    throw new RunsError("protocol", "invalid_request", "startBackgroundRun starts background runs only.")
  }
  if (!opts.target.authToken) {
    throw new RunsError("http", "auth_required", "Background tasks need sign-in.", 401)
  }
  const res = await sendAuthed(
    opts,
    runsUrl(opts.target, "/v1/runs"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    opts.signal,
    body.runId,
  )
  if (!res.ok) throw await runsErrorFromResponse(res)
  const accepted = await readJson<Partial<BackgroundRunAccepted>>(res, "start")
  if (typeof accepted?.runId !== "string" || typeof accepted.status !== "string") {
    throw new RunsError("protocol", "invalid_response", "The start response had no run.", res.status)
  }
  return { runId: accepted.runId, status: accepted.status }
}

/** `startBackgroundRun` answering an interrupted top-level background run
 *  (Q24, Q41): a new run with `previousRunId` and `resume[]`. Its body
 *  needs no history — the resume starts from the paused run's saved state
 *  (RUN_EVENTS.md § 4.2). */
export function resumeBackgroundRun(
  request: { runId: string; threadId: string; previousRunId: string; resume: ResumeEntry[] },
  opts: RunRequestOptions,
): Promise<BackgroundRunAccepted> {
  return startBackgroundRun(
    {
      threadId: request.threadId,
      runId: request.runId,
      messages: [],
      resume: request.resume,
      forwardedProps: { mode: "background", previousRunId: request.previousRunId },
    } as StartRunRequest,
    opts,
  )
}

/** The query string of `listRuns` (`status` repeated; booleans as
 *  `true` / `false`; absent keys left out). */
export function listRunsQueryString(query: ListRunsQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v))
    else params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

/** `GET /v1/runs` — one page of the caller's runs, newest first. */
export async function listRuns(query: ListRunsQuery, opts: RunRequestOptions): Promise<RunList> {
  const res = await sendAuthed(
    opts,
    runsUrl(opts.target, `/v1/runs${listRunsQueryString(query)}`),
    { method: "GET", headers: { Accept: "application/json" } },
    opts.signal,
    null,
  )
  if (!res.ok) throw await runsErrorFromResponse(res)
  const page = await readJson<Partial<RunList>>(res, "list")
  if (!page || !Array.isArray(page.runs)) {
    throw new RunsError("protocol", "invalid_response", "The list response had no runs.", res.status)
  }
  return { runs: page.runs, nextPageToken: page.nextPageToken ?? null }
}

async function postRun(
  runId: string,
  suffix: string,
  body: unknown,
  opts: RunRequestOptions,
): Promise<Run> {
  const res = await sendAuthed(
    opts,
    runsUrl(opts.target, runPath(runId, suffix)),
    {
      method: "POST",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    opts.signal,
    runId,
  )
  if (!res.ok) throw await runsErrorFromResponse(res)
  const run = await readJson<Run>(res, "run")
  if (!run || typeof run !== "object" || typeof run.status !== "string") {
    throw new RunsError("protocol", "invalid_response", "The run response had no status.", res.status)
  }
  return run
}

/**
 * Answer a **sub-agent** run's question in place (`POST
 * /v1/runs/{id}/answers`, Q59, RUN_EVENTS.md § 4.4) → `202` with the run
 * still `interrupted` and `answerPending: true` until a worker picks it up.
 * `409 run_already_answered` / `invalid_state` / `limit_reached` throw.
 */
export function answerRun(runId: string, resume: ResumeEntry[], opts: RunRequestOptions): Promise<Run> {
  const body: AnswerRunRequest = { resume: resume as AnswerRunRequest["resume"] }
  return postRun(runId, "/answers", body, opts)
}

/** Mark a finished task delivered (`POST /v1/runs/{root}/delivered`, Q77):
 *  idempotent, the first mark is kept. `409 invalid_state` for a run that
 *  isn't a root, or a task that hasn't ended. */
export function markRunDelivered(rootRunId: string, opts: RunRequestOptions): Promise<Run> {
  return postRun(rootRunId, "/delivered", undefined, opts)
}
