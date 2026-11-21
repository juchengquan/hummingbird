/**
 * Shared error categorisation for AI Gateway-backed routes
 * (chat, command, copilot). Maps a thrown error to a stable `{ status, code,
 * message }` triple so the client can render typed inline UI rather than
 * generic toasts.
 */

export type ApiErrorCode =
  | 'auth'
  | 'auth_required'
  | 'rate_limit'
  | 'context_window'
  | 'invalid_model'
  | 'unknown_model'
  | 'invalid_attachment'
  | 'provider'
  | 'aborted'
  | 'unknown'

/**
 * `auth_required` — the *caller* isn't signed in and the server requires
 * sign-in for AI routes (`REQUIRE_AUTH_FOR_AI`). Distinct from `auth`,
 * which means the server's/provider's API key is missing or rejected
 * (the client's mock-response fallback keys off `auth`, never this).
 * Always `401 { code: 'auth_required', message }`.
 */
export const AUTH_REQUIRED_CODE = 'auth_required' satisfies ApiErrorCode

export const AUTH_REQUIRED_MESSAGE = 'Sign in to use AI features on this server.'

/**
 * `invalid_attachment` — the backend can't give the model something the
 * user attached (agent-py's `/v1/runs`: an unsupported image / document
 * type, a file over its size limit, too many images or documents).
 * Always `400 { code: 'invalid_attachment', message }`, before the run
 * exists; nothing else categorises into it.
 */
export const INVALID_ATTACHMENT_CODE = 'invalid_attachment' satisfies ApiErrorCode

export const INVALID_ATTACHMENT_MESSAGE =
  "An attached file or image can't be sent to the model — it may be too large, of an unsupported type, or one too many. Remove it from this chat and retry."

/** True when an error envelope (or SSE error frame) carries `auth_required`. */
export function isAuthRequiredError(
  error: { code?: string | null } | null | undefined,
): boolean {
  return error?.code === AUTH_REQUIRED_CODE
}

export interface CategorizedError {
  status: number
  code: ApiErrorCode
  message: string
}

/**
 * Where an HTTP status may appear in a provider error message. Anchored
 * so a 3-digit number elsewhere in the text (a token count, a request
 * id, a model name like `…-400b`) isn't read as a status.
 */
const STATUS_IN_MESSAGE: readonly RegExp[] = [
  /^\s*(\d{3})\b/, // "429 Too Many Requests", "401"
  /\bhttp(?:\/[\d.]+)?\s*[:(]?\s*(\d{3})\b/i, // "HTTP 502", "HTTP/1.1 503", "(HTTP 401)"
  /\bstatus(?:\s*code)?\s*[:=]?\s*(\d{3})\b/i, // "status 429", "status code: 401"
  /\b(?:error|code)\s*[:=]?\s*(\d{3})\b/i, // "Error 503", "code: 429"
]

/**
 * The upstream HTTP status, or null. A numeric `statusCode` / `status`
 * on the error (the AI SDK's `APICallError` carries `statusCode`) wins;
 * otherwise only anchored mentions in the message count. 4xx/5xx only.
 */
export function upstreamStatus(error: unknown, message: string): number | null {
  const isHttpError = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 400 && n <= 599
  if (error && typeof error === 'object') {
    const e = error as { statusCode?: unknown; status?: unknown }
    if (isHttpError(e.statusCode)) return e.statusCode
    if (isHttpError(e.status)) return e.status
  }
  for (const pattern of STATUS_IN_MESSAGE) {
    const n = Number(pattern.exec(message)?.[1])
    if (isHttpError(n)) return n
  }
  return null
}

export function categorizeError(error: unknown): CategorizedError {
  const message = error instanceof Error ? error.message : 'Unknown error'

  if (error instanceof Error && error.name === 'AbortError') {
    return { status: 408, code: 'aborted', message }
  }
  // Thrown by `selectModel` (server) for a model id outside
  // `config/models.json` without a BYO key. Matched by name because this
  // module is isomorphic and can't import the server-only class.
  if (error instanceof Error && error.name === 'UnknownModelError') {
    return { status: 400, code: 'unknown_model', message }
  }

  const lower = message.toLowerCase()
  const status = upstreamStatus(error, message)

  if (/rate.?limit|quota|too many requests/.test(lower) || status === 429) {
    return { status: 429, code: 'rate_limit', message }
  }
  // Context-window busts surface from Anthropic / OpenAI as 400s with
  // characteristic phrases. Detect them BEFORE the generic
  // invalid_model 400-bucket so they don't get miscategorised.
  if (
    /prompt is too long|context.?window|context.?length|maximum.*context|maximum.*tokens|too many tokens|input is too long|exceeds.*token|reduce.*input/.test(
      lower,
    )
  ) {
    return { status: 400, code: 'context_window', message }
  }
  if (/invalid.*model|model.*not.found|unknown model/.test(lower) || status === 400) {
    return { status: 400, code: 'invalid_model', message }
  }
  if (/unauthor|forbidden/.test(lower) || status === 401 || status === 403) {
    return { status: 401, code: 'auth', message }
  }
  if (
    /bad gateway|provider|upstream/.test(lower) ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return { status: 502, code: 'provider', message }
  }
  return { status: 500, code: 'unknown', message }
}
