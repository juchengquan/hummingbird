import "client-only"
/**
 * Single typed entry point for every frontend → backend call.
 *
 * Every component / hook in the codebase must go through `apiClient`
 * rather than calling `fetch('/api/...')` directly. The Plate-driven
 * AI routes are configured by URL string and consume those strings
 * from `apiClient.urls.*` so they pick up the same base URL.
 *
 * Why this exists: see docs/PLAN-backend-extraction.md. The body of
 * each method is a thin fetch wrapper today; when the backend moves to
 * Python, the only thing that has to change is `API_BASE_URL` (or, if
 * the same-origin reverse-proxy path is taken, nothing changes at all).
 *
 * Response validation: where a Zod response schema exists in
 * lib/api-schemas.ts, we parse with it so a server returning a wrong
 * shape fails loudly here instead of silently breaking the UI. The
 * streaming chat response isn't validated — its frame protocol is
 * pinned in docs/API.md and parsed inline by the chat panel.
 */

import {
  CreateShareResponseSchema,
  EmbedResponseSchema,
  ExtractionResponseSchema,
  FileSummarizeResponseSchema,
  ConversationSummarizeResponseSchema,
  CompressSummarizeResponseSchema,
  ProjectBreakdownResponseSchema,
  RefreshImageUrlResponseSchema,
  RevokeShareResponseSchema,
  type ChatRequestInput,
  type TaskRequestInput,
  type RespondRequestInput,
  ScheduleListResponseSchema,
  ScheduleResponseSchema,
  type ScheduleCreateInput,
  type ScheduleResponse,
  type ScheduleUpdateInput,
  type CreateShareRequestInput,
  type CreateShareResponse,
  type ExtractionResponse,
  type FileSummarizeResponse,
  type ConversationSummarizeResponse,
  type CompressSummarizeResponse,
  type ProjectBreakdownResponse,
  type SummarizeRequestInput,
  type EmbedRequestInput,
  type EmbedResponse,
  type ExtractTableRequestInput,
} from "@/shared/api-schemas"

import { CitationTableSchema, type CitationTable } from "@/shared/artifacts/citation-table"

import { narrowToRemoteBody } from "@/client/api/chat-marshalling"

/** Optional remote-backend dispatch context — used by non-chat
 *  endpoints that mirror `/v1/...` on agent-py / agent-ts. When
 *  set on a call's options, the method posts to the remote service
 *  with a Bearer JWT instead of the in-Next route. Resolved by the
 *  default-auto branch via `resolveRemoteBackend()` (separate file
 *  so api-client.ts can stay Zustand-free in unit tests). */
export interface RemoteDispatch {
  backend: "python" | "ts-service"
  baseUrl: string
  authToken: string
}

/** Per-call dispatch options for non-chat endpoints. Three states:
 *  - undefined / { dispatch: 'auto' } (default) — read backend from
 *    the chat-backend store; resolve the JWT lazily; fall through
 *    to the in-Next route on any prerequisite miss.
 *  - { dispatch: 'in-next' } — force the in-Next route regardless
 *    of the user's backend choice (used for cases where the remote
 *    service hasn't shipped the endpoint yet, or for endpoints that
 *    are explicitly in-Next-only).
 *  - { dispatch: 'remote', remote } — explicit remote dispatch with
 *    a pre-resolved context. Skips the resolver. */
export type DispatchOption =
  | { dispatch?: "auto" }
  | { dispatch: "in-next" }
  | { dispatch: "remote"; remote: RemoteDispatch }

/** Result shape returned by `dispatchedFetch`. Mirrors the existing
 *  tagged-result convention used by `mcpProxyCall`, `mcpUpsertCloudServer`,
 *  and `urlFetchBookmark`. */
export type DispatchedFetchResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: { code?: string; message?: string } }

/** Options for `dispatchedFetch`. The caller passes BOTH the remote
 *  path (e.g. `/v1/summarize`) and the local URL string — keeps the
 *  helper free of the `apiUrls` namespace import and keeps it testable
 *  with literal URL strings. */
export interface DispatchedFetchOptions<LocalBody, RemoteBody, T> {
  path: string
  localUrl: string
  bodyForLocal: LocalBody
  bodyForRemote?: (local: LocalBody) => RemoteBody
  schema?: {
    safeParse: (
      raw: unknown,
    ) => { success: true; data: T } | { success: false; error: unknown }
  }
  extraHeaders?: Record<string, string>
  signal?: AbortSignal
  inflight?: Map<string, Promise<DispatchedFetchResult<T>>>
  dedupeKey?: string
  dispatch?: DispatchOption
}

/** Internal: turn a `DispatchOption` (or undefined) into a concrete
 *  `RemoteDispatch | null`. Importing the resolver lazily keeps the
 *  Zustand store + Supabase client off any callgraph that doesn't
 *  actually need them. */
async function resolveDispatch(
  option: DispatchOption | undefined
): Promise<RemoteDispatch | null> {
  if (option?.dispatch === "in-next") return null
  if (option?.dispatch === "remote") return option.remote
  const { resolveRemoteBackend } = await import("@/client/api/backend-resolver")
  return resolveRemoteBackend()
}

/** Resolve the `DispatchOption` and return a stable cache key that
 *  includes the backend URL so a backend switch mid-session doesn't
 *  return a stale signed URL from the wrong service. The in-Next
 *  fast path returns just the suffix. Used by
 *  `refreshGeneratedImageUrl`'s in-flight dedupe. */
async function backendCacheKey(
  option: DispatchOption | undefined,
  suffix: string,
): Promise<string> {
  if (option?.dispatch === "in-next") return suffix
  if (option?.dispatch === "remote") return `${option.remote.baseUrl}::${suffix}`
  // Default 'auto' — resolve lazily.
  const { resolveRemoteBackend } = await import("@/client/api/backend-resolver")
  const remote = await resolveRemoteBackend()
  return remote ? `${remote.baseUrl}::${suffix}` : suffix
}

/** Internal: one POST + optional Zod-parse for any dispatched
 *  (auto / in-next / remote) non-chat endpoint. The exported
 *  `apiClient.*` methods share dispatch + error handling; they
 *  differ only in path, body, and (optionally) response schema +
 *  wire-shape variant. This is the seam that absorbs all six.
 *
 *  Errors swallowed into the `{ ok: false, ... }` envelope:
 *  network error, non-OK response, JSON parse error, schema
 *  rejection. Callers convert back to their own contract (most
 *  return `null`; the MCP + URL-fetch ones surface the envelope). */
async function dispatchedFetch<LocalBody, RemoteBody, T>(
  options: DispatchedFetchOptions<LocalBody, RemoteBody, T>,
): Promise<DispatchedFetchResult<T>> {
  const inflight = options.inflight
  const dedupeKey = options.dedupeKey
  if (inflight && dedupeKey) {
    const cached = inflight.get(dedupeKey)
    if (cached) return cached
  }

  const promise = (async (): Promise<DispatchedFetchResult<T>> => {
    try {
      const remote = await resolveDispatch(options.dispatch)
      const target = remote
        ? `${remote.baseUrl}${options.path}`
        : options.localUrl
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      if (remote) headers.Authorization = `Bearer ${remote.authToken}`
      if (options.extraHeaders) {
        Object.assign(headers, options.extraHeaders)
      }
      const body = options.bodyForRemote
        ? options.bodyForRemote(options.bodyForLocal)
        : options.bodyForLocal
      const res = await fetch(target, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
      if (!res.ok) {
        const errBody = await readErrorBody(res)
        return {
          ok: false,
          status: res.status,
          error: {
            code: errBody.code,
            message: errBody.message ?? errBody.error,
          },
        }
      }
      const raw: unknown = await res.json()
      if (options.schema) {
        const parsed = options.schema.safeParse(raw)
        if (!parsed.success) {
          return {
            ok: false,
            status: res.status,
            error: {
              code: "invalid_response",
              message: "Server response did not match schema.",
            },
          }
        }
        return { ok: true, status: res.status, data: parsed.data }
      }
      return { ok: true, status: res.status, data: raw as T }
    } catch {
      return {
        ok: false,
        status: 0,
        error: { code: "network_error", message: "Request failed." },
      }
    }
  })()

  if (inflight && dedupeKey) {
    inflight.set(dedupeKey, promise)
    try {
      return await promise
    } finally {
      inflight.delete(dedupeKey)
    }
  }
  return promise
}

// Empty default = same origin (Next.js routes serving from /api/*).
// When the Python backend is ready, set NEXT_PUBLIC_API_BASE_URL to its
// origin (e.g. "https://api.example.com"); the same-origin reverse-proxy
// option from the plan would leave this empty and add a Vercel rewrite.
const API_BASE_URL = (
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_BASE_URL
    ? process.env.NEXT_PUBLIC_API_BASE_URL
    : ""
).replace(/\/+$/, "")

/**
 * Base URL for the Python agent service (`services/agent-py/`). Set
 * to its origin (e.g. `http://localhost:8000` in dev) to enable the
 * "Chat backend → Python" toggle in the account menu. Empty / unset →
 * the apiClient ignores the `backend: 'python'` option and falls
 * through to the TS route, so a misconfigured deploy degrades safely.
 *
 * Phase 4-2 of `PLAN-agent-api.md`. Per user policy, both stacks
 * stay live indefinitely — this is the selector wire, not a cutover.
 */
export const AGENT_PY_BASE_URL = (
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_AGENT_PY_URL
    ? process.env.NEXT_PUBLIC_AGENT_PY_URL
    : ""
).replace(/\/+$/, "")

/** Whether the Python agent endpoint is reachable as a backend
 *  option. The UI toggle hides itself when this is false so users
 *  don't see a switch that does nothing. */
export function isAgentPyConfigured(): boolean {
  return AGENT_PY_BASE_URL.length > 0
}

/**
 * Base URL for the TypeScript agent service (`services/agent-ts/`).
 * Set to its origin (e.g. `http://localhost:8001` in dev) to enable
 * the "TypeScript agent service" option in the account-menu chat-
 * backend selector. Empty / unset → the apiClient ignores the
 * `backend: 'ts-service'` option and falls through to the in-Next
 * TS route, same defensive degradation as `agent-py`.
 *
 * Phase 5 of `PLAN-agent-ts.md`. Per project policy, all three
 * stacks coexist — this is the third option on the selector wire,
 * not a replacement for either existing backend.
 */
export const AGENT_TS_BASE_URL = (
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_AGENT_TS_URL
    ? process.env.NEXT_PUBLIC_AGENT_TS_URL
    : ""
).replace(/\/+$/, "")

/** Whether the TS agent service endpoint is reachable. Mirrors
 *  `isAgentPyConfigured` — same UI gating semantics. */
export function isAgentTsConfigured(): boolean {
  return AGENT_TS_BASE_URL.length > 0
}

function url(path: string): string {
  return `${API_BASE_URL}${path}`
}

/**
 * Path strings exposed for callers that can't go through a method
 * (e.g. Plate's `useChat` config takes a `api` URL string and handles
 * the fetch internally). Always read from here so the base URL switch
 * propagates everywhere.
 */
export const apiUrls = {
  chat: () => url("/api/chat"),
  tasks: () => url("/api/tasks"),
  taskSweep: () => url("/api/tasks/sweep"),
  taskSchedules: () => url("/api/tasks/schedules"),
  taskScheduleById: (id: string) =>
    url(`/api/tasks/schedules/${encodeURIComponent(id)}`),
  taskCancel: (id: string) =>
    url(`/api/tasks/${encodeURIComponent(id)}/cancel`),
  taskRespond: (id: string) =>
    url(`/api/tasks/${encodeURIComponent(id)}/respond`),
  taskStream: (id: string) =>
    url(`/api/tasks/${encodeURIComponent(id)}/stream`),
  aiCommand: () => url("/api/ai/command"),
  aiComplete: () => url("/api/ai/complete"),
  extract: () => url("/api/extract"),
  embed: () => url("/api/embed"),
  summarize: () => url("/api/summarize"),
  share: () => url("/api/share"),
  shareToken: (token: string) =>
    url(`/api/share/${encodeURIComponent(token)}`),
  mcp: (serverId: string, action: "discover" | "call" | "read") =>
    url(`/api/mcp/${encodeURIComponent(serverId)}/${action}`),
  mcpServer: () => url("/api/mcp/server"),
  urlFetch: () => url("/api/url/fetch"),
  imagesRefreshUrl: () => url("/api/images/refresh-url"),
  extractTable: () => url("/api/extract-table"),
}

/**
 * Read a JSON error envelope from a non-OK response, falling back to
 * an empty object when the body isn't JSON. The caller can pull `code`
 * / `message` off the result; we don't throw an Error here because the
 * chat client interprets the status + envelope specifically.
 */
async function readErrorBody(
  res: Response
): Promise<{ code?: string; message?: string; error?: string }> {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

// --- /api/chat (streaming) --------------------------------------------------

export interface ChatStreamResult {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
  /** Populated on non-OK; same shape callers built inline before. */
  error?: { code?: string; message?: string }
}

export type ChatBackendOption = "ts" | "python" | "ts-service"

export interface ChatStreamOptions {
  signal?: AbortSignal
  /** Which backend to call. Defaults to `'ts'` — the Next.js route.
   *  `'python'` calls the agent-py service's `/v1/chat`; requires a
   *  reachable `NEXT_PUBLIC_AGENT_PY_URL` AND an `authToken`.
   *  `'ts-service'` calls the agent-ts service's `/v1/chat`;
   *  requires `NEXT_PUBLIC_AGENT_TS_URL` AND an `authToken`. Any
   *  prerequisite missing → silently falls through to the TS route. */
  backend?: ChatBackendOption
  /** Supabase session JWT, required when `backend === 'python'` or
   *  `backend === 'ts-service'`. Caller resolves via
   *  `supabase.auth.getSession()`. */
  authToken?: string | null
}

/**
 * Initiates a chat request. Returns the raw stream so the caller can
 * parse the SSE frames itself — the protocol is documented in
 * `docs/API.md`. The chat panel currently does this inline because the
 * frame handling is tightly coupled to its placeholder + tool-call
 * state machine.
 *
 * Phase 4-2: agent-py backend dispatch. Phase 5 of PLAN-agent-ts:
 * agent-ts backend dispatch. `options.backend === 'python'` routes
 * to agent-py's `/v1/chat`; `'ts-service'` routes to agent-ts's
 * `/v1/chat`. Either falls back to the in-Next TS route on any
 * prerequisite failure (URL unset / token missing). The SSE wire
 * shape matches across all three producers (text / error / done
 * frames + optional tool_call / tool_result / tool_image) so the
 * consumer (`use-chat-send.ts`) doesn't branch on backend.
 */
async function chatStream(
  body: ChatRequestInput,
  options?: ChatStreamOptions
): Promise<ChatStreamResult> {
  const token = options?.authToken ?? null
  const hasToken = typeof token === "string" && token.length > 0

  if (
    options?.backend === "python" &&
    AGENT_PY_BASE_URL.length > 0 &&
    hasToken
  ) {
    return chatStreamRemote(body, AGENT_PY_BASE_URL, token, options.signal)
  }
  if (
    options?.backend === "ts-service" &&
    AGENT_TS_BASE_URL.length > 0 &&
    hasToken
  ) {
    return chatStreamRemote(body, AGENT_TS_BASE_URL, token, options.signal)
  }
  return chatStreamTs(body, options)
}

async function chatStreamTs(
  body: ChatRequestInput,
  options?: ChatStreamOptions
): Promise<ChatStreamResult> {
  const res = await fetch(apiUrls.chat(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      body: null,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  return { ok: true, status: res.status, body: res.body }
}

/** Single remote-backend dispatch — used for both agent-py and
 *  agent-ts. Same wire shape, same JWT-bearer auth, same SSE
 *  response. Empty `model` short-circuits to the TS route since
 *  both services treat it as required and would 422. */
async function chatStreamRemote(
  body: ChatRequestInput,
  baseUrl: string,
  authToken: string,
  signal: AbortSignal | undefined,
): Promise<ChatStreamResult> {
  const narrowed = narrowToRemoteBody(body)
  if (!narrowed.model) {
    return chatStreamTs(body, { signal })
  }
  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(narrowed),
    signal,
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      body: null,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  return { ok: true, status: res.status, body: res.body }
}

// --- /api/tasks (long-running agent — enqueue + stream) -------------------

/** Result of `tasksStart` / `tasksRespond`. The POST is a thin enqueue
 *  (returns 202); the caller opens `tasksResume` to watch events as the
 *  worker emits them. */
export interface TaskEnqueueResult {
  ok: boolean
  status: number
  runId?: string
  error?: { code?: string; message?: string }
}

/**
 * Start a long-running task. After Phase 6 steps 3+4 of
 * `PLAN-agent-task-queue.md` this is a JSON POST that enqueues a `start`
 * job and returns `202 { runId }`. The caller then opens
 * `tasksResume(runId, 0)` to watch events as the background worker
 * produces them.
 */
async function tasksStart(
  body: TaskRequestInput,
  options?: { signal?: AbortSignal }
): Promise<TaskEnqueueResult> {
  const res = await fetch(apiUrls.tasks(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  try {
    const data = (await res.json()) as { runId?: string }
    if (typeof data.runId !== "string" || !data.runId) {
      return {
        ok: false,
        status: res.status,
        error: { code: "invalid_response", message: "Server did not return a runId." },
      }
    }
    return { ok: true, status: res.status, runId: data.runId }
  } catch {
    return {
      ok: false,
      status: res.status,
      error: { code: "invalid_response", message: "Server response was not JSON." },
    }
  }
}

/**
 * Reconnect to a run's event log. Replays from `cursor` (the last
 * `seq` already folded) via the native `Last-Event-ID` SSE header, then
 * tails until the run settles. Same stream envelope as `tasksStart`.
 */
async function tasksResume(
  id: string,
  options?: { cursor?: number; signal?: AbortSignal }
): Promise<ChatStreamResult> {
  const headers: Record<string, string> = {}
  if (options?.cursor && options.cursor > 0) {
    headers["Last-Event-ID"] = String(options.cursor)
  }
  const res = await fetch(apiUrls.taskStream(id), {
    headers,
    signal: options?.signal,
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      body: null,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  return { ok: true, status: res.status, body: res.body }
}

/**
 * Request cancellation of a running task. The server flips the run's
 * status to `cancelled`; the runner settles on its next between-step
 * poll. Idempotent — cancelling an already-settled run is a no-op.
 */
async function tasksCancel(
  id: string
): Promise<{ ok: boolean; status: number; error?: { code?: string; message?: string } }> {
  const res = await fetch(apiUrls.taskCancel(id), { method: "POST" })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  return { ok: true, status: res.status }
}

/**
 * Resolve a HITL pending input on a paused run — approve/reject a
 * gated tool, choose option(s), or submit a value. After Phase 6
 * steps 3+4, this is a thin JSON POST that enqueues a `respond` job
 * and returns 202. The caller relies on its existing resume-stream
 * subscription to see the continuation.
 */
async function tasksRespond(
  id: string,
  body: RespondRequestInput,
  options?: { signal?: AbortSignal }
): Promise<{ ok: boolean; status: number; error?: { code?: string; message?: string } }> {
  const res = await fetch(apiUrls.taskRespond(id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  return { ok: true, status: res.status }
}

/**
 * Reconcile the caller's orphaned runs (best-effort). Called on
 * dashboard mount so runs whose function died mid-stream get flipped to
 * `failed` server-side. Returns the count reconciled; swallows failures.
 */
async function tasksSweep(): Promise<number> {
  try {
    const res = await fetch(apiUrls.taskSweep(), { method: "POST" })
    if (!res.ok) return 0
    const data = (await res.json()) as { failed?: number }
    return typeof data.failed === "number" ? data.failed : 0
  } catch {
    return 0
  }
}

// --- /api/tasks/schedules (recurring task runs) ----------------------------

async function schedulesList(): Promise<ScheduleResponse[]> {
  try {
    const res = await fetch(apiUrls.taskSchedules())
    if (!res.ok) return []
    const data = ScheduleListResponseSchema.parse(await res.json())
    return data.schedules
  } catch {
    return []
  }
}

async function schedulesCreate(
  body: ScheduleCreateInput
): Promise<
  | { ok: true; status: number; schedule: ScheduleResponse }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const res = await fetch(apiUrls.taskSchedules(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  return {
    ok: true,
    status: res.status,
    schedule: ScheduleResponseSchema.parse(await res.json()),
  }
}

async function schedulesUpdate(
  id: string,
  patch: ScheduleUpdateInput
): Promise<
  | { ok: true; status: number; schedule: ScheduleResponse }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const res = await fetch(apiUrls.taskScheduleById(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  return {
    ok: true,
    status: res.status,
    schedule: ScheduleResponseSchema.parse(await res.json()),
  }
}

async function schedulesDelete(
  id: string
): Promise<{ ok: boolean; status: number; error?: { code?: string; message?: string } }> {
  const res = await fetch(apiUrls.taskScheduleById(id), { method: "DELETE" })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  return { ok: true, status: res.status }
}

// --- /api/extract -----------------------------------------------------------

/**
 * Posts a file to /api/extract. Resolves to `null` on any failure —
 * callers (`runExtraction` in lib/extract.ts) treat that as a
 * pipeline failure and mark the file `failed`. We don't surface error
 * detail today because the file row's status badge carries that info.
 */
async function extract(
  file: File,
  options?: { signal?: AbortSignal }
): Promise<ExtractionResponse | null> {
  const form = new FormData()
  form.append("file", file)
  try {
    const res = await fetch(apiUrls.extract(), {
      method: "POST",
      body: form,
      signal: options?.signal,
    })
    if (!res.ok) return null
    return ExtractionResponseSchema.parse(await res.json())
  } catch {
    return null
  }
}

// --- /api/embed -------------------------------------------------------------

/**
 * Chunk + embed a file's extracted text into the `file_sections` vector
 * table (PLAN-local-rag.md PR 2). Best-effort: resolves to the parsed
 * status on success, or `null` on any failure (anonymous → 401, network
 * error, malformed response) — callers treat indexing as background
 * decoration that quietly no-ops when it can't run.
 */
async function embedFile(
  body: EmbedRequestInput,
  options?: { signal?: AbortSignal }
): Promise<EmbedResponse | null> {
  try {
    const res = await fetch(apiUrls.embed(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!res.ok) return null
    return EmbedResponseSchema.parse(await res.json())
  } catch {
    return null
  }
}

// --- /api/summarize ---------------------------------------------------------

type SummarizeOptions = { signal?: AbortSignal } & DispatchOption

/** Internal: one POST + Zod-parse for any summarize mode. The four
 *  exported methods (file / conversation / compress / projectBreakdown)
 *  share dispatch + error handling; they differ only in the body's
 *  `mode` discriminant and the response schema. */
async function summarizePost<T>(
  body: SummarizeRequestInput,
  schema: {
    safeParse: (
      raw: unknown,
    ) => { success: true; data: T } | { success: false; error: unknown }
  },
  options?: SummarizeOptions,
): Promise<T | null> {
  const result = await dispatchedFetch<
    SummarizeRequestInput,
    SummarizeRequestInput,
    T
  >({
    path: "/v1/summarize",
    localUrl: apiUrls.summarize(),
    bodyForLocal: body,
    schema,
    signal: options?.signal,
    dispatch: options,
  })
  return result.ok ? result.data : null
}

/** Summarises a single file's extracted text. Returns null on failure —
 *  summaries are best-effort decoration on the file row. */
function summarizeFile(
  body: Extract<SummarizeRequestInput, { mode: "file" }>,
  options?: SummarizeOptions
): Promise<FileSummarizeResponse | null> {
  return summarizePost(body, FileSummarizeResponseSchema, options)
}

/** Summarises a conversation thread. Used by the chat-header
 *  "Summarise" action. Returns null on failure; the caller surfaces a
 *  toast. */
function summarizeConversation(
  body: Extract<SummarizeRequestInput, { mode: "conversation" }>,
  options?: SummarizeOptions
): Promise<ConversationSummarizeResponse | null> {
  return summarizePost(body, ConversationSummarizeResponseSchema, options)
}

/** Compresses a slice of older messages into a markdown recap intended
 *  to substitute for them in the next chat turn. Used by the chat
 *  header's "Compress" action when the context meter is in the
 *  warn/danger zone. Returns null on failure; the caller surfaces a
 *  toast and aborts the compress. */
function summarizeCompress(
  body: Extract<SummarizeRequestInput, { mode: "compress" }>,
  options?: SummarizeOptions
): Promise<CompressSummarizeResponse | null> {
  return summarizePost(body, CompressSummarizeResponseSchema, options)
}

/** Breaks a project goal into proposed task titles for the Kanban board
 *  (project-mode "Generate tasks" action). Returns null on failure; the
 *  caller surfaces a toast. */
function summarizeProjectBreakdown(
  body: Extract<SummarizeRequestInput, { mode: "project-breakdown" }>,
  options?: SummarizeOptions
): Promise<ProjectBreakdownResponse | null> {
  return summarizePost(body, ProjectBreakdownResponseSchema, options)
}

// --- /api/share -------------------------------------------------------------

export interface ShareCreateResult {
  ok: boolean
  status: number
  data?: CreateShareResponse
  error?: string
}

async function createShare(
  body: CreateShareRequestInput
): Promise<ShareCreateResult> {
  const res = await fetch(apiUrls.share(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return { ok: false, status: res.status, error: errBody.error }
  }
  return {
    ok: true,
    status: res.status,
    data: CreateShareResponseSchema.parse(await res.json()),
  }
}

/**
 * Re-sign an expired generated-image URL from its `storagePath`. Returns
 * the fresh URL, or `null` if Supabase isn't configured / the caller
 * isn't signed in / the object went missing. The caller is responsible
 * for updating wherever the old URL was held (typically
 * `Message.generatedImages[i].url`).
 *
 * Concurrent calls for the same `storagePath` are deduped via an
 * in-flight cache so a 4-up grid with all four URLs expired only
 * fires one network round-trip per distinct path.
 */
const refreshUrlInflight = new Map<string, Promise<string | null>>()

async function refreshGeneratedImageUrl(
  storagePath: string,
  options?: DispatchOption
): Promise<string | null> {
  const remote = await resolveDispatch(options)
  // Cache key includes the backend URL so a backend switch mid-session
  // doesn't return a stale signed URL from the wrong service. The hot
  // path (no remote, in-Next) uses just the storage path.
  const cacheKey = remote
    ? `${remote.baseUrl}::${storagePath}`
    : storagePath
  const cached = refreshUrlInflight.get(cacheKey)
  if (cached) return cached
  const promise = (async () => {
    try {
      const url = remote
        ? `${remote.baseUrl}/v1/images/refresh-url`
        : apiUrls.imagesRefreshUrl()
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      if (remote) {
        headers.Authorization = `Bearer ${remote.authToken}`
      }
      // Wire shape: agent-py + agent-ts use snake_case
      // (`storage_path`); the in-Next route uses camelCase
      // (`storagePath`) per `RefreshImageUrlRequestSchema`. Pick the
      // right one per target.
      const body = remote
        ? { storage_path: storagePath }
        : { storagePath }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) return null
      const parsed = RefreshImageUrlResponseSchema.safeParse(await res.json())
      return parsed.success ? parsed.data.url : null
    } catch {
      return null
    }
  })()
  refreshUrlInflight.set(cacheKey, promise)
  try {
    return await promise
  } finally {
    refreshUrlInflight.delete(cacheKey)
  }
}

async function revokeShare(token: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const res = await fetch(apiUrls.shareToken(token), { method: "DELETE" })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return { ok: false, status: res.status, error: errBody.error }
  }
  RevokeShareResponseSchema.parse(await res.json())
  return { ok: true, status: res.status }
}

// --- /api/mcp (proxy) -------------------------------------------------------

/**
 * Posts an MCP proxy call. Returns the parsed JSON body on success; on
 * failure returns the error envelope so the caller can show a useful
 * toast (creds never leave this function — they're sent via the
 * `X-MCP-Credentials` header, not echoed back).
 */
type McpProxyOptions = {
  credentialHeader?: string
  signal?: AbortSignal
} & DispatchOption

async function mcpProxyCall(
  action: "discover" | "call" | "read",
  body: Record<string, unknown>,
  options?: McpProxyOptions
): Promise<
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const serverId = (body.server as { id?: string } | undefined)?.id
  if (!serverId) {
    return {
      ok: false,
      status: 400,
      error: { code: "missing_server_id", message: "server.id is required" },
    }
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (options?.credentialHeader) {
    headers["X-MCP-Credentials"] = options.credentialHeader
  }
  const remote = await resolveDispatch(options)
  // Path shape matches the in-Next route (`/api/mcp/:id/:action`) AND
  // both services (`/v1/mcp/:server_id/:action`). Body + header
  // formats are byte-identical, so the only branch is the base URL.
  const url = remote
    ? `${remote.baseUrl}/v1/mcp/${encodeURIComponent(serverId)}/${action}`
    : apiUrls.mcp(serverId, action)
  if (remote) {
    headers.Authorization = `Bearer ${remote.authToken}`
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options?.signal,
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  return {
    ok: true,
    status: res.status,
    data: (await res.json()) as Record<string, unknown>,
  }
}

/**
 * Persists a cloud-mode MCP server config + credential. The browser
 * can't write to `credentials_encrypted` directly (no encryption key
 * client-side), so this route wraps the SECURITY DEFINER RPC.
 *
 * Returns `ok: true` on success. The credential never round-trips:
 * the route stores the encrypted ciphertext in Supabase and the client
 * forgets it.
 */
async function mcpUpsertCloudServer(
  body: {
    id: string
    workspaceId: string
    name: string
    url: string
    credentials: { type?: string; headers?: Record<string, string> }
    capabilities?: Record<string, unknown>
    enabled?: boolean
    requires_approval?: boolean
  },
  options?: DispatchOption
): Promise<
  | { ok: true; status: number }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const remote = await resolveDispatch(options)
  const url = remote ? `${remote.baseUrl}/v1/mcp/server` : apiUrls.mcpServer()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (remote) headers.Authorization = `Bearer ${remote.authToken}`
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  return { ok: true, status: res.status }
}

// --- /api/url/fetch ---------------------------------------------------------

export interface UrlFetchSnapshot {
  url: string
  title: string
  content: string
  contentTruncated: boolean
  contentHash: string
  description?: string
  faviconUrl?: string
}

/**
 * Fetch + extract a URL bookmark snapshot. The server handles all
 * fetching (CORS + SSRF defense + extraction); the client just hands
 * over the URL and stores the result.
 */
async function urlFetchBookmark(
  url: string,
  options?: DispatchOption
): Promise<
  | { ok: true; status: number; bookmark: UrlFetchSnapshot }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const remote = await resolveDispatch(options)
  const target = remote
    ? `${remote.baseUrl}/v1/url/fetch`
    : apiUrls.urlFetch()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (remote) {
    headers.Authorization = `Bearer ${remote.authToken}`
  }
  const res = await fetch(target, {
    method: "POST",
    headers,
    body: JSON.stringify({ url }),
  })
  if (!res.ok) {
    const errBody = await readErrorBody(res)
    return {
      ok: false,
      status: res.status,
      error: { code: errBody.code, message: errBody.message ?? errBody.error },
    }
  }
  const data = (await res.json()) as { ok: boolean; bookmark: UrlFetchSnapshot }
  return { ok: true, status: res.status, bookmark: data.bookmark }
}

// --- /api/extract-table -----------------------------------------------------

/**
 * Extract a structured citation table from a research report and its
 * source list. Mirrors the `summarizePost` dispatch pattern: tries the
 * remote backend first (when configured), falls back to the in-Next
 * route. Returns `null` on any failure — callers treat a missing table
 * as a degraded-but-safe outcome.
 */
async function extractTable(
  body: ExtractTableRequestInput,
  options?: { signal?: AbortSignal } & DispatchOption,
): Promise<CitationTable | null> {
  const result = await dispatchedFetch<
    ExtractTableRequestInput,
    ExtractTableRequestInput,
    CitationTable
  >({
    path: "/v1/extract-table",
    localUrl: apiUrls.extractTable(),
    bodyForLocal: body,
    schema: CitationTableSchema,
    signal: options?.signal,
    dispatch: options,
  })
  return result.ok ? result.data : null
}

// --- Public surface ---------------------------------------------------------

export const apiClient = {
  urls: apiUrls,
  chat: { stream: chatStream },
  tasks: {
    start: tasksStart,
    resume: tasksResume,
    cancel: tasksCancel,
    respond: tasksRespond,
    sweep: tasksSweep,
    schedules: {
      list: schedulesList,
      create: schedulesCreate,
      update: schedulesUpdate,
      delete: schedulesDelete,
    },
  },
  extract,
  embed: { file: embedFile },
  summarize: {
    file: summarizeFile,
    conversation: summarizeConversation,
    compress: summarizeCompress,
    projectBreakdown: summarizeProjectBreakdown,
  },
  share: {
    create: createShare,
    revoke: revokeShare,
  },
  images: {
    refreshUrl: refreshGeneratedImageUrl,
  },
  mcp: { proxy: mcpProxyCall, upsertCloudServer: mcpUpsertCloudServer },
  url: { fetch: urlFetchBookmark },
  artifacts: { extractTable },
}
