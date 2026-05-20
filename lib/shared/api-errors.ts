/**
 * Shared error categorisation for AI Gateway-backed routes
 * (chat, command, copilot). Maps a thrown error to a stable `{ status, code,
 * message }` triple so the client can render typed inline UI rather than
 * generic toasts.
 */

export type ApiErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'invalid_model'
  | 'provider'
  | 'aborted'
  | 'unknown'

export interface CategorizedError {
  status: number
  code: ApiErrorCode
  message: string
}

export function categorizeError(error: unknown): CategorizedError {
  const message = error instanceof Error ? error.message : 'Unknown error'

  if (error instanceof Error && error.name === 'AbortError') {
    return { status: 408, code: 'aborted', message }
  }

  const lower = message.toLowerCase()

  if (/rate.?limit|quota|too many requests|429/.test(lower)) {
    return { status: 429, code: 'rate_limit', message }
  }
  if (/invalid.*model|model.*not.found|unknown model|400/.test(lower)) {
    return { status: 400, code: 'invalid_model', message }
  }
  if (/unauthor|forbidden|401|403/.test(lower)) {
    return { status: 401, code: 'auth', message }
  }
  if (/bad gateway|provider|upstream|502|503|504/.test(lower)) {
    return { status: 502, code: 'provider', message }
  }
  return { status: 500, code: 'unknown', message }
}
