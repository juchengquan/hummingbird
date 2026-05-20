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
  RevokeShareResponseSchema,
  type ChatRequestInput,
  type CreateShareRequestInput,
  type CreateShareResponse,
  type ExtractionResponse,
  type FileSummarizeResponse,
  type ConversationSummarizeResponse,
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
  aiCommand: () => url("/api/ai/command"),
  aiCopilot: () => url("/api/ai/copilot"),
  extract: () => url("/api/extract"),
  summarize: () => url("/api/summarize"),
  share: () => url("/api/share"),
  shareToken: (token: string) =>
    url(`/api/share/${encodeURIComponent(token)}`),
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

// --- Public surface ---------------------------------------------------------

export const apiClient = {
  urls: apiUrls,
  chat: { stream: chatStream },
  extract,
  summarize: {
    file: summarizeFile,
    conversation: summarizeConversation,
  },
  share: {
    create: createShare,
    revoke: revokeShare,
  },
}

export type ApiClient = typeof apiClient
