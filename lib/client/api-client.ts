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
  ExtractionResponseSchema,
  FileSummarizeResponseSchema,
  ConversationSummarizeResponseSchema,
  CompressSummarizeResponseSchema,
  RevokeShareResponseSchema,
  type ChatRequestInput,
  type TaskRequestInput,
  type CreateShareRequestInput,
  type CreateShareResponse,
  type ExtractionResponse,
  type FileSummarizeResponse,
  type ConversationSummarizeResponse,
  type CompressSummarizeResponse,
  type SummarizeRequestInput,
} from "@/shared/api-schemas"

// Empty default = same origin (Next.js routes serving from /api/*).
// When the Python backend is ready, set NEXT_PUBLIC_API_BASE_URL to its
// origin (e.g. "https://api.example.com"); the same-origin reverse-proxy
// option from the plan would leave this empty and add a Vercel rewrite.
const API_BASE_URL = (
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_BASE_URL
    ? process.env.NEXT_PUBLIC_API_BASE_URL
    : ""
).replace(/\/+$/, "")

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
  taskCancel: (id: string) =>
    url(`/api/tasks/${encodeURIComponent(id)}/cancel`),
  taskStream: (id: string) =>
    url(`/api/tasks/${encodeURIComponent(id)}/stream`),
  aiCommand: () => url("/api/ai/command"),
  aiCopilot: () => url("/api/ai/copilot"),
  extract: () => url("/api/extract"),
  summarize: () => url("/api/summarize"),
  share: () => url("/api/share"),
  shareToken: (token: string) =>
    url(`/api/share/${encodeURIComponent(token)}`),
  mcp: (serverId: string, action: "discover" | "call" | "read") =>
    url(`/api/mcp/${encodeURIComponent(serverId)}/${action}`),
  mcpServer: () => url("/api/mcp/server"),
  urlFetch: () => url("/api/url/fetch"),
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

/**
 * Initiates a chat request. Returns the raw stream so the caller can
 * parse the SSE frames itself — the protocol is documented in
 * `docs/API.md`. The chat panel currently does this inline because the
 * frame handling is tightly coupled to its placeholder + tool-call
 * state machine.
 */
async function chatStream(
  body: ChatRequestInput,
  options?: { signal?: AbortSignal }
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

// --- /api/tasks (long-running agent — streaming) ----------------------------

/**
 * Start a long-running task. Returns the raw AI-SDK data stream of
 * `data-agent-event` parts (see `lib/shared/agent/wire.ts`); the caller
 * decodes each part with `fromDataPart` and folds it through
 * `reduceRun`. Same `{ok, status, body, error}` envelope as `chatStream`.
 */
async function tasksStart(
  body: TaskRequestInput,
  options?: { signal?: AbortSignal }
): Promise<ChatStreamResult> {
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

// --- /api/summarize ---------------------------------------------------------

/**
 * Summarises a single file's extracted text. Returns null on failure —
 * summaries are best-effort decoration on the file row.
 */
async function summarizeFile(
  body: Extract<SummarizeRequestInput, { mode: "file" }>,
  options?: { signal?: AbortSignal }
): Promise<FileSummarizeResponse | null> {
  try {
    const res = await fetch(apiUrls.summarize(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!res.ok) return null
    return FileSummarizeResponseSchema.parse(await res.json())
  } catch {
    return null
  }
}

/**
 * Summarises a conversation thread. Used by the chat-header
 * "Summarise" action. Returns null on failure; the caller surfaces a
 * toast.
 */
async function summarizeConversation(
  body: Extract<SummarizeRequestInput, { mode: "conversation" }>,
  options?: { signal?: AbortSignal }
): Promise<ConversationSummarizeResponse | null> {
  try {
    const res = await fetch(apiUrls.summarize(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!res.ok) return null
    return ConversationSummarizeResponseSchema.parse(await res.json())
  } catch {
    return null
  }
}

/**
 * Compresses a slice of older messages into a markdown recap intended
 * to substitute for them in the next chat turn. Used by the chat
 * header's "Compress" action when the context meter is in the
 * warn/danger zone. Returns null on failure; the caller surfaces a
 * toast and aborts the compress.
 */
async function summarizeCompress(
  body: Extract<SummarizeRequestInput, { mode: "compress" }>,
  options?: { signal?: AbortSignal }
): Promise<CompressSummarizeResponse | null> {
  try {
    const res = await fetch(apiUrls.summarize(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!res.ok) return null
    return CompressSummarizeResponseSchema.parse(await res.json())
  } catch {
    return null
  }
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
async function mcpProxyCall(
  action: "discover" | "call" | "read",
  body: Record<string, unknown>,
  options?: { credentialHeader?: string; signal?: AbortSignal }
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
  const res = await fetch(apiUrls.mcp(serverId, action), {
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
async function mcpUpsertCloudServer(body: {
  id: string
  workspaceId: string
  name: string
  url: string
  credentials: { type?: string; headers?: Record<string, string> }
  capabilities?: Record<string, unknown>
  enabled?: boolean
}): Promise<
  | { ok: true; status: number }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const res = await fetch(apiUrls.mcpServer(), {
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
async function urlFetchBookmark(url: string): Promise<
  | { ok: true; status: number; bookmark: UrlFetchSnapshot }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const res = await fetch(apiUrls.urlFetch(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

// --- Public surface ---------------------------------------------------------

export const apiClient = {
  urls: apiUrls,
  chat: { stream: chatStream },
  tasks: { start: tasksStart, cancel: tasksCancel },
  extract,
  summarize: {
    file: summarizeFile,
    conversation: summarizeConversation,
    compress: summarizeCompress,
  },
  share: {
    create: createShare,
    revoke: revokeShare,
  },
  mcp: { proxy: mcpProxyCall, upsertCloudServer: mcpUpsertCloudServer },
  url: { fetch: urlFetchBookmark },
}

export type ApiClient = typeof apiClient
