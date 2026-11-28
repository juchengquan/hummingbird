/**
 * The error codes a backend error envelope (`{ code, message }`) carries,
 * so the client can render typed inline UI rather than generic toasts.
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
 * exists.
 */
export const INVALID_ATTACHMENT_MESSAGE =
  "An attached file or image can't be sent to the model — it may be too large, of an unsupported type, or one too many. Remove it from this chat and retry."

/** True when an error envelope (or SSE error frame) carries `auth_required`. */
export function isAuthRequiredError(
  error: { code?: string | null } | null | undefined,
): boolean {
  return error?.code === AUTH_REQUIRED_CODE
}
