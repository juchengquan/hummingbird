import "client-only"
/**
 * Single typed entry point for every frontend → backend call.
 *
 * Every component / hook in the codebase must go through `apiClient`
 * rather than calling `fetch` directly. Every call goes to agent-py
 * (`NEXT_PUBLIC_AGENT_PY_URL`, wave 13, Q142): there is no Next.js API
 * any more, and a deploy without agent-py shows the no-backend screen
 * (`components/no-backend-gate.tsx`) instead of the app.
 *
 * A call carries the signed-in session's bearer when there is one, and
 * goes tokenless otherwise: agent-py serves some calls anonymously (URL
 * fetch, summarize, extract, extract-table, the MCP proxy, embed — Q123)
 * and answers the account-bound ones `401 auth_required`, which surfaces
 * as "Sign in required" (`notifyAuthRequired`). Nothing is refused here.
 *
 * Response validation: where a Zod response schema exists in
 * lib/shared/api-schemas.ts, we parse with it so a server returning a
 * wrong shape fails loudly here instead of silently breaking the UI.
 */

import {
  CreateShareResponseSchema,
  EmbedResponseSchema,
  ExtractionResponseSchema,
  FileSummarizeResponseSchema,
  MemoryExtractResponseSchema,
  ConversationSummarizeResponseSchema,
  CompressSummarizeResponseSchema,
  ProjectBreakdownResponseSchema,
  RefreshImageUrlResponseSchema,
  RefreshFileUrlResponseSchema,
  RevokeShareResponseSchema,
  ResolvedShareResponseSchema,
  ScheduleListResponseSchema,
  ScheduleResponseSchema,
  type ScheduleCreateInput,
  type ScheduleResponse,
  type ScheduleUpdateInput,
  type CreateShareRequestInput,
  type CreateShareResponse,
  type ResolvedShareResponse,
  type MemoryExtractRequestInput,
  type MemoryExtractResponse,
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
import { AUTH_REQUIRED_CODE, isAuthRequiredError } from "@/shared/api-errors"
import { resolveBackendBaseUrl } from "@/shared/backend-base-url"

import {
  cancelRun,
  getRun,
  rejoinRun,
  resumeRun,
  startRun,
} from "@/client/runs/transport"
import {
  answerRun,
  listRuns,
  markRunDelivered,
  resumeBackgroundRun,
  startBackgroundRun,
} from "@/client/runs/background"
import { notifyAuthRequired } from "@/client/auth/auth-required"

/** Where a call goes: agent-py's base URL, with the session's bearer or
 *  tokenless (`null` — no `Authorization` header is sent). */
export interface AgentPyTarget {
  /** `""` when agent-py is served on the page's own origin. */
  baseUrl: string
  authToken: string | null
}

/** Per-call options every agent-py method takes. `target` skips the
 *  session lookup (`resolveAgentPyTarget`) — tests pass one. */
export interface CallOptions {
  target?: AgentPyTarget
}

/** The target for one call: the given one, else agent-py with the
 *  session's token, if any. The resolver is imported lazily so the
 *  Zustand store + Supabase client stay off callgraphs that don't need
 *  them. */
async function targetFor(options: CallOptions | undefined): Promise<AgentPyTarget> {
  if (options?.target) return options.target
  const { resolveAgentPyTarget } = await import("@/client/api/backend-resolver")
  return resolveAgentPyTarget()
}

function requestHeaders(target: AgentPyTarget, json: boolean): Record<string, string> {
  const headers: Record<string, string> = json ? { "Content-Type": "application/json" } : {}
  if (target.authToken) headers.Authorization = `Bearer ${target.authToken}`
  return headers
}

/** Result shape returned by `dispatchedFetch`. Mirrors the existing
 *  tagged-result convention used by `mcpProxyCall`, `mcpUpsertCloudServer`,
 *  and `urlFetchBookmark`. */
export type DispatchedFetchResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: { code?: string; message?: string } }

/** Options for `dispatchedFetch`. */
export interface DispatchedFetchOptions<Body, T> extends CallOptions {
  /** The agent-py path, e.g. `/v1/summarize`. */
  path: string
  /** Defaults to POST. A DELETE sends no body and no Content-Type. */
  method?: "POST" | "DELETE"
  body: Body
  schema?: {
    safeParse: (
      raw: unknown,
    ) => { success: true; data: T } | { success: false; error: unknown }
  }
  extraHeaders?: Record<string, string>
  signal?: AbortSignal
  inflight?: Map<string, Promise<DispatchedFetchResult<T>>>
  dedupeKey?: string
  /** A `401 auth_required` raises the "Sign in" toast (`notifyAuthRequired`);
   *  `true` for calls the user didn't trigger (rate-limited). */
  background?: boolean
}

/**
 * A failed response's error, read for the caller. A call sent without a
 * token that agent-py refused `401` reads as `auth_required` whatever its
 * code: the caller must sign in (Q142) — it is surfaced as "Sign in
 * required", never as a generic failure. Either way the toast is raised.
 */
function failureOf(
  status: number,
  body: ErrorBody,
  target: AgentPyTarget,
  background: boolean | undefined,
): { code?: string; message?: string } {
  const error = errorOf(body)
  const authRequired =
    isAuthRequiredError(error) || (status === 401 && target.authToken === null)
  if (!authRequired) return error
  notifyAuthRequired({ background: background === true })
  return { ...error, code: AUTH_REQUIRED_CODE }
}

/** Internal: one request + optional Zod-parse for any agent-py endpoint.
 *  The exported `apiClient.*` methods share target resolution and error
 *  handling; they differ only in path, body, and (optionally) response
 *  schema.
 *
 *  Errors swallowed into the `{ ok: false, ... }` envelope:
 *  network error, non-OK response, JSON parse error, schema
 *  rejection. Callers convert back to their own contract (most
 *  return `null`; the MCP + URL-fetch ones surface the envelope). */
async function dispatchedFetch<Body, T>(
  options: DispatchedFetchOptions<Body, T>,
): Promise<DispatchedFetchResult<T>> {
  const inflight = options.inflight
  const dedupeKey = options.dedupeKey
  if (inflight && dedupeKey) {
    const cached = inflight.get(dedupeKey)
    if (cached) return cached
  }

  const promise = (async (): Promise<DispatchedFetchResult<T>> => {
    try {
      const target = await targetFor(options)
      const method = options.method ?? "POST"
      const hasBody = method !== "DELETE"
      const headers = requestHeaders(target, hasBody)
      if (options.extraHeaders) {
        Object.assign(headers, options.extraHeaders)
      }
      const res = await fetch(`${target.baseUrl}${options.path}`, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      })
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: failureOf(res.status, await readErrorBody(res), target, options.background),
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

/**
 * Base URL for the Python agent service (`services/agent-py/`): its
 * origin (e.g. `http://localhost:8000` in dev), or `/` when a reverse
 * proxy serves agent-py on the frontend's own origin
 * (`PLAN-frontend-backend-split.md` Q21) — requests then go to `/v1/...`
 * on the current origin and the prefix is `""`. See
 * `resolveBackendBaseUrl` (`@/shared/backend-base-url`). Unset → the
 * deploy has no backend (Q137): the app shows the no-backend screen.
 */
const AGENT_PY = resolveBackendBaseUrl(
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AGENT_PY_URL : undefined
)
export const AGENT_PY_BASE_URL = AGENT_PY.baseUrl

/**
 * URL strings for callers that can't go through a method (Plate's editor
 * AI takes an `api` URL and handles the fetch itself): agent-py's editor
 * AI routes (wave 9).
 */
export const apiUrls = {
  aiCommand: () => `${AGENT_PY_BASE_URL}/v1/ai/command`,
  aiComplete: () => `${AGENT_PY_BASE_URL}/v1/ai/complete`,
}

/** Whether this deploy names a backend (`NEXT_PUBLIC_AGENT_PY_URL`). Not
 *  `AGENT_PY_BASE_URL !== ""`: the same-origin value `/` resolves to an
 *  empty prefix. */
export function isAgentPyConfigured(): boolean {
  return AGENT_PY.configured
}

/**
 * Read a JSON error envelope from a non-OK response, falling back to
 * an empty object when the body isn't JSON. The caller can pull `code`
 * / `message` off the result; we don't throw an Error here because the
 * chat client interprets the status + envelope specifically.
 */
type ErrorBody = { code?: string; message?: string; error?: string | { code?: string; message?: string } }

async function readErrorBody(res: Response): Promise<ErrorBody> {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

/** A failed response's code and message, whichever envelope it came in:
 *  agent-py's flat `{ code, message }`, a Next route's nested
 *  `{ ok: false, error: { code, message } }`, or a bare `{ error: "…" }`. */
function errorOf(body: ErrorBody): { code?: string; message?: string } {
  if (body.error && typeof body.error === "object") {
    return { code: body.error.code ?? body.code, message: body.error.message ?? body.message }
  }
  return { code: body.code, message: body.message ?? body.error }
}

// --- /v1/tasks/schedules (recurring task runs) -----------------------------

const SCHEDULES_PATH = "/v1/tasks/schedules"
const scheduleByIdPath = (id: string) =>
  `${SCHEDULES_PATH}/${encodeURIComponent(id)}`

type ScheduleFailure = {
  ok: false
  status: number
  error: { code?: string; message?: string }
}

/** One schedules request: agent-py, bearer when signed in (account-bound:
 *  tokenless, agent-py answers `401 auth_required`). */
async function scheduleFetch(
  path: string,
  init: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; background?: boolean },
  options: CallOptions | undefined,
): Promise<{ ok: true; res: Response } | ScheduleFailure> {
  const target = await targetFor(options)
  const hasBody = init.body !== undefined
  const res = await fetch(`${target.baseUrl}${path}`, {
    method: init.method,
    headers: requestHeaders(target, hasBody),
    body: hasBody ? JSON.stringify(init.body) : undefined,
  })
  if (res.ok) return { ok: true, res }
  return {
    ok: false,
    status: res.status,
    error: failureOf(res.status, await readErrorBody(res), target, init.background),
  }
}

async function schedulesList(options?: CallOptions): Promise<ScheduleResponse[]> {
  try {
    const out = await scheduleFetch(SCHEDULES_PATH, { method: "GET", background: true }, options)
    if (!out.ok) return []
    const data = ScheduleListResponseSchema.parse(await out.res.json())
    return data.schedules
  } catch {
    return []
  }
}

async function schedulesCreate(
  body: ScheduleCreateInput,
  options?: CallOptions,
): Promise<
  | { ok: true; status: number; schedule: ScheduleResponse }
  | ScheduleFailure
> {
  const out = await scheduleFetch(SCHEDULES_PATH, { method: "POST", body }, options)
  if (!out.ok) return out
  return {
    ok: true,
    status: out.res.status,
    schedule: ScheduleResponseSchema.parse(await out.res.json()),
  }
}

async function schedulesUpdate(
  id: string,
  patch: ScheduleUpdateInput,
  options?: CallOptions,
): Promise<
  | { ok: true; status: number; schedule: ScheduleResponse }
  | ScheduleFailure
> {
  const out = await scheduleFetch(scheduleByIdPath(id), { method: "PATCH", body: patch }, options)
  if (!out.ok) return out
  return {
    ok: true,
    status: out.res.status,
    schedule: ScheduleResponseSchema.parse(await out.res.json()),
  }
}

async function schedulesDelete(
  id: string,
  options?: CallOptions,
): Promise<{ ok: boolean; status: number; error?: { code?: string; message?: string } }> {
  const out = await scheduleFetch(scheduleByIdPath(id), { method: "DELETE" }, options)
  if (!out.ok) return out
  return { ok: true, status: out.res.status }
}

// --- /v1/extract -------------------------------------------------------------

/**
 * Posts a file for text extraction (`/v1/extract`, multipart). Resolves
 * to `null` on any failure — callers (`runExtraction` in lib/extract.ts)
 * treat that as a pipeline failure and mark the file `failed`. We don't
 * surface error detail today because the file row's status badge carries
 * that info. agent-py serves it signed out too (Q123).
 */
async function extract(
  file: File,
  options?: { signal?: AbortSignal } & CallOptions,
): Promise<ExtractionResponse | null> {
  const form = new FormData()
  form.append("file", file)
  try {
    const target = await targetFor(options)
    const res = await fetch(`${target.baseUrl}/v1/extract`, {
      method: "POST",
      headers: requestHeaders(target, false),
      body: form,
      signal: options?.signal,
    })
    if (!res.ok) return null
    return ExtractionResponseSchema.parse(await res.json())
  } catch {
    return null
  }
}

// --- /v1/embed -------------------------------------------------------------

/**
 * Chunk + embed a file's extracted text into the `file_sections` vector
 * table (PLAN-local-rag.md PR 2). Best-effort: resolves to the parsed
 * status on success (signed out it is a `skipped / not_signed_in`
 * result), or `null` on any failure — callers treat indexing as
 * background decoration that quietly no-ops when it can't run.
 */
async function embedFile(
  body: EmbedRequestInput,
  options?: { signal?: AbortSignal } & CallOptions,
): Promise<EmbedResponse | null> {
  const result = await dispatchedFetch<EmbedRequestInput, EmbedResponse>({
    path: "/v1/embed",
    body,
    schema: EmbedResponseSchema,
    signal: options?.signal,
    target: options?.target,
    background: true,
  })
  return result.ok ? result.data : null
}

// --- REQUIRE_AUTH_FOR_AI ----------------------------------------------------

/**
 * Returned (instead of `null`) by the best-effort AI methods below
 * (summarize.*, artifacts.extractTable) when the server answered
 * `401 { code: "auth_required" }`. The "Sign in" toast has already been
 * raised via `notifyAuthRequired()`; callers only need to skip their own
 * generic failure message. A distinct value (not `null`) so the type
 * system makes every caller handle it.
 */
export const AUTH_REQUIRED_RESULT: { readonly authRequired: true } =
  Object.freeze({ authRequired: true as const })
export type AuthRequiredResult = typeof AUTH_REQUIRED_RESULT

export function isAuthRequiredResult(value: unknown): value is AuthRequiredResult {
  return value === AUTH_REQUIRED_RESULT
}

/** Map a failed call to `AUTH_REQUIRED_RESULT` (its toast was raised by
 *  `dispatchedFetch`) or `null`. */
function failureResult(
  result: Extract<DispatchedFetchResult<unknown>, { ok: false }>,
): AuthRequiredResult | null {
  return isAuthRequiredError(result.error) ? AUTH_REQUIRED_RESULT : null
}

// --- /v1/summarize ---------------------------------------------------------

type SummarizeOptions = { signal?: AbortSignal } & CallOptions

/** Internal: one POST + Zod-parse for any summarize mode. The four
 *  exported methods (file / conversation / compress / projectBreakdown)
 *  share dispatch + error handling; they differ only in the body's
 *  `mode` discriminant and the response schema. Every mode resolves to
 *  `AUTH_REQUIRED_RESULT` (not `null`) on `401 auth_required`. */
async function summarizePost<T>(
  body: SummarizeRequestInput,
  schema: {
    safeParse: (
      raw: unknown,
    ) => { success: true; data: T } | { success: false; error: unknown }
  },
  options?: SummarizeOptions,
): Promise<T | AuthRequiredResult | null> {
  const result = await dispatchedFetch<SummarizeRequestInput, T>({
    path: "/v1/summarize",
    body,
    schema,
    signal: options?.signal,
    target: options?.target,
    // File summaries run in the background on upload; the rest are
    // user-initiated actions.
    background: body.mode === "file",
  })
  return result.ok ? result.data : failureResult(result)
}

/** Summarises a single file's extracted text. Returns null on failure —
 *  summaries are best-effort decoration on the file row. */
function summarizeFile(
  body: Extract<SummarizeRequestInput, { mode: "file" }>,
  options?: SummarizeOptions
): Promise<FileSummarizeResponse | AuthRequiredResult | null> {
  return summarizePost(body, FileSummarizeResponseSchema, options)
}

/** Summarises a conversation thread. Used by the chat-header
 *  "Summarise" action. Returns null on failure; the caller surfaces a
 *  toast. */
function summarizeConversation(
  body: Extract<SummarizeRequestInput, { mode: "conversation" }>,
  options?: SummarizeOptions
): Promise<ConversationSummarizeResponse | AuthRequiredResult | null> {
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
): Promise<CompressSummarizeResponse | AuthRequiredResult | null> {
  return summarizePost(body, CompressSummarizeResponseSchema, options)
}

/** Breaks a project goal into proposed task titles for the Kanban board
 *  (project-mode "Generate tasks" action). Returns null on failure; the
 *  caller surfaces a toast. */
function summarizeProjectBreakdown(
  body: Extract<SummarizeRequestInput, { mode: "project-breakdown" }>,
  options?: SummarizeOptions
): Promise<ProjectBreakdownResponse | AuthRequiredResult | null> {
  return summarizePost(body, ProjectBreakdownResponseSchema, options)
}

// --- /v1/share -------------------------------------------------------------

export interface ShareCreateResult {
  ok: boolean
  status: number
  data?: CreateShareResponse
  error?: string
}

/** Mint a share token (`POST /v1/share`, account-bound). */
async function createShare(
  body: CreateShareRequestInput,
  options?: CallOptions,
): Promise<ShareCreateResult> {
  const result = await dispatchedFetch<CreateShareRequestInput, CreateShareResponse>({
    path: "/v1/share",
    body,
    schema: CreateShareResponseSchema,
    target: options?.target,
  })
  return result.ok
    ? { ok: true, status: result.status, data: result.data }
    : { ok: false, status: result.status, error: result.error.message }
}

export type ShareResolveResult =
  | { ok: true; status: number; data: ResolvedShareResponse }
  | {
      ok: false
      status: number
      /** The backend answered 404: unknown, revoked or unresolvable
       *  token — render the not-found page. Anything else (network,
       *  5xx, 429, a malformed body) is transient. */
      notFound: boolean
    }

/**
 * Public read of a share for the read-only share pages:
 * `GET /v1/share/{token}` on agent-py. Anonymous by design — no
 * Authorization header, no cookies — so it works for viewers without an
 * account. Without a configured backend it returns `{ ok: false,
 * status: 0 }` (the no-backend screen covers that deploy anyway).
 *
 * `options.baseUrl` overrides the configured prefix (tests).
 */
async function resolveShareFromBackend(
  token: string,
  options?: { signal?: AbortSignal; baseUrl?: string },
): Promise<ShareResolveResult> {
  const baseUrl = options?.baseUrl ?? (AGENT_PY.configured ? AGENT_PY.baseUrl : null)
  if (baseUrl === null) return { ok: false, status: 0, notFound: false }
  try {
    const res = await fetch(`${baseUrl}/v1/share/${encodeURIComponent(token)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      signal: options?.signal,
    })
    if (!res.ok) {
      return { ok: false, status: res.status, notFound: res.status === 404 }
    }
    const parsed = ResolvedShareResponseSchema.safeParse(await res.json())
    if (!parsed.success) return { ok: false, status: res.status, notFound: false }
    return { ok: true, status: res.status, data: parsed.data }
  } catch {
    return { ok: false, status: 0, notFound: false }
  }
}

/** Revoke a share (`DELETE /v1/share/{token}`, account-bound). */
async function revokeShare(
  token: string,
  options?: CallOptions,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const result = await dispatchedFetch<undefined, { ok: true }>({
    method: "DELETE",
    path: `/v1/share/${encodeURIComponent(token)}`,
    body: undefined,
    schema: RevokeShareResponseSchema,
    target: options?.target,
  })
  return result.ok
    ? { ok: true, status: result.status }
    : { ok: false, status: result.status, error: result.error.message }
}

// --- /v1/memory/extract ----------------------------------------------------

/**
 * Trigger best-effort cross-conversation memory extraction for one
 * finished turn (`/v1/memory/extract`, account-bound). Resolves `true`
 * when the backend accepted the body, `false` on any failure (non-OK
 * status, malformed response, network error) — never rejects, so callers
 * can fire-and-forget.
 */
async function memoryExtract(
  body: MemoryExtractRequestInput,
  options?: CallOptions,
): Promise<boolean> {
  const result = await dispatchedFetch<MemoryExtractRequestInput, MemoryExtractResponse>({
    path: "/v1/memory/extract",
    body,
    schema: MemoryExtractResponseSchema,
    target: options?.target,
    background: true,
  })
  return result.ok
}

/** In-flight dedupe cache for `refreshGeneratedImageUrl`, keyed on
 *  `${baseUrl}::${storagePath}`. Module-scoped because the dedupe
 *  contract is "same logical URL re-sign in flight, share the promise." */
const refreshUrlInflight = new Map<
  string,
  Promise<DispatchedFetchResult<{ url: string }>>
>()

/** Re-sign a generated image's Storage URL (`/v1/images/refresh-url`,
 *  snake_case body). */
async function refreshGeneratedImageUrl(
  storagePath: string,
  options?: CallOptions,
): Promise<string | null> {
  const target = await targetFor(options)
  const result = await dispatchedFetch<{ storage_path: string }, { url: string }>({
    path: "/v1/images/refresh-url",
    body: { storage_path: storagePath },
    schema: RefreshImageUrlResponseSchema,
    target,
    background: true,
    inflight: refreshUrlInflight,
    dedupeKey: `${target.baseUrl}::${storagePath}`,
  })
  if (!result.ok) return null
  return result.data.url
}

/** In-flight dedupe cache for `refreshGeneratedFileUrl`. Separate map
 *  from the image one so the two never collide on a shared key. */
const refreshFileUrlInflight = new Map<
  string,
  Promise<DispatchedFetchResult<{ url: string }>>
>()

/** Re-sign a generated file's Storage URL (`/v1/files/refresh-url`,
 *  camelCase body, unlike the image one). */
async function refreshGeneratedFileUrl(
  storagePath: string,
  options?: CallOptions,
): Promise<string | null> {
  const target = await targetFor(options)
  const result = await dispatchedFetch<{ storagePath: string }, { url: string }>({
    path: "/v1/files/refresh-url",
    body: { storagePath },
    schema: RefreshFileUrlResponseSchema,
    target,
    background: true,
    inflight: refreshFileUrlInflight,
    dedupeKey: `${target.baseUrl}::${storagePath}`,
  })
  if (!result.ok) return null
  return result.data.url
}

// --- /v1/mcp (proxy) -------------------------------------------------------

/**
 * Posts an MCP proxy call. Returns the parsed JSON body on success; on
 * failure returns the error envelope so the caller can show a useful
 * toast (creds never leave this function — they're sent via the
 * `X-MCP-Credentials` header, not echoed back).
 */
type McpProxyOptions = {
  credentialHeader?: string
  signal?: AbortSignal
} & CallOptions

async function mcpProxyCall(
  action: "discover" | "call" | "read",
  body: Record<string, unknown>,
  options?: McpProxyOptions,
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
  const extraHeaders: Record<string, string> = {}
  if (options?.credentialHeader) {
    extraHeaders["X-MCP-Credentials"] = options.credentialHeader
  }
  const result = await dispatchedFetch<Record<string, unknown>, Record<string, unknown>>({
    path: `/v1/mcp/${encodeURIComponent(serverId)}/${action}`,
    body,
    extraHeaders,
    signal: options?.signal,
    // Signed out: local-mode servers only (agent-py never looks up a
    // cloud-mode server for an anonymous caller).
    target: options?.target,
  })
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
    }
  }
  return { ok: true, status: result.status, data: result.data }
}

/**
 * Persists a cloud-mode MCP server config + credential
 * (`/v1/mcp/server`, account-bound). The browser can't write to
 * `credentials_encrypted` directly (no encryption key client-side), so
 * this route wraps the SECURITY DEFINER RPC.
 *
 * Returns `ok: true` on success. The credential never round-trips:
 * the backend stores the encrypted ciphertext in Supabase and the client
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
  options?: CallOptions,
): Promise<
  | { ok: true; status: number }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const result = await dispatchedFetch<typeof body, Record<string, never>>({
    path: "/v1/mcp/server",
    body,
    target: options?.target,
  })
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
    }
  }
  return { ok: true, status: result.status }
}

// --- /v1/url/fetch ---------------------------------------------------------

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
  options?: CallOptions,
): Promise<
  | { ok: true; status: number; bookmark: UrlFetchSnapshot }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const result = await dispatchedFetch<
    { url: string },
    { ok: boolean; bookmark: UrlFetchSnapshot }
  >({
    path: "/v1/url/fetch",
    body: { url },
    target: options?.target,
  })
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
    }
  }
  return { ok: true, status: result.status, bookmark: result.data.bookmark }
}

// --- /v1/extract-table -----------------------------------------------------

/**
 * Extract a structured citation table from a research report and its
 * source list (`/v1/extract-table`; agent-py serves it signed out too).
 * Returns `null` on any failure — callers treat a missing table as a
 * degraded-but-safe outcome.
 */
async function extractTable(
  body: ExtractTableRequestInput,
  options?: { signal?: AbortSignal } & CallOptions,
): Promise<CitationTable | AuthRequiredResult | null> {
  const result = await dispatchedFetch<ExtractTableRequestInput, CitationTable>({
    path: "/v1/extract-table",
    body,
    schema: CitationTableSchema,
    signal: options?.signal,
    target: options?.target,
  })
  return result.ok ? result.data : failureResult(result)
}

// --- Public surface ---------------------------------------------------------

export const apiClient = {
  urls: apiUrls,
  /** agent-py's runs API (`/v1/runs`) — chat on runs (Q33). Transport in
   *  `lib/client/runs/transport.ts`; sessions that drive it through
   *  `@ag-ui/client` into the store are in `lib/client/runs/session.ts`
   *  (see `lib/client/runs/README.md`). Unlike the rest of `apiClient`,
   *  these throw `RunsError`. */
  runs: {
    start: startRun,
    rejoin: rejoinRun,
    status: getRun,
    cancel: cancelRun,
    resume: resumeRun,
    /** Background runs — the tasks panel (wave 6, `runs/background.ts`). */
    startBackground: startBackgroundRun,
    resumeBackground: resumeBackgroundRun,
    list: listRuns,
    answer: answerRun,
    markDelivered: markRunDelivered,
  },
  tasks: {
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
    resolve: resolveShareFromBackend,
  },
  memory: { extract: memoryExtract },
  images: {
    refreshUrl: refreshGeneratedImageUrl,
  },
  files: {
    refreshUrl: refreshGeneratedFileUrl,
  },
  mcp: { proxy: mcpProxyCall, upsertCloudServer: mcpUpsertCloudServer },
  url: { fetch: urlFetchBookmark },
  artifacts: { extractTable },
}
