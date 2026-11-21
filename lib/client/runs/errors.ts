import "client-only"

/**
 * Typed errors of the runs client, and their mapping onto the chat's
 * existing `MessageError` codes (the error bubble).
 *
 * Every transport call (`transport.ts`) throws `RunsError` and nothing
 * else; a run that *fails* (rather than a request) ends its stream with
 * `RUN_ERROR { code, message }`, which the reducer maps with the same
 * `messageErrorFor` so both reach the bubble alike.
 */

import type { MessageError, MessageErrorCode } from "@/shared/types"

/**
 * - `http` — the backend answered non-2xx (`status`, wire `code`);
 * - `network` — no response, or the stream broke and reconnecting failed;
 * - `aborted` — the caller's signal aborted the request (Stop, unmount);
 * - `protocol` — a response we can't read (not SSE, a frame that isn't
 *   JSON, a 2xx without the expected body).
 */
export type RunsErrorKind = "http" | "network" | "aborted" | "protocol"

/** Wire codes the runs operations add to `ApiError` (`openapi.yaml`). */
export const RUN_ID_CONFLICT = "run_id_conflict"
export const RUN_ALREADY_RESUMED = "run_already_resumed"
export const INVALID_STATE = "invalid_state"
export const INVALID_ATTACHMENT = "invalid_attachment"

export class RunsError extends Error {
  readonly kind: RunsErrorKind
  /** HTTP status; 0 when there was no response. */
  readonly status: number
  /** The backend's `code` (`rate_limit`, `run_id_conflict`, …), or
   *  `network` / `aborted` / `invalid_response` for the other kinds. */
  readonly code: string

  constructor(kind: RunsErrorKind, code: string, message: string, status = 0) {
    super(message)
    this.name = "RunsError"
    this.kind = kind
    this.code = code
    this.status = status
  }

  /** The chat bubble for this error (`MessageError`). */
  toMessageError(model?: string): MessageError {
    return messageErrorFor(this.code, {
      status: this.status || undefined,
      detail: this.message,
      model,
    })
  }
}

export function isRunsError(value: unknown): value is RunsError {
  return value instanceof RunsError
}

/** Codes the bubble already knows, passed through unchanged. */
const KNOWN: ReadonlySet<MessageErrorCode> = new Set<MessageErrorCode>([
  "auth",
  "auth_required",
  "rate_limit",
  "context_window",
  "invalid_model",
  "unknown_model",
  "invalid_attachment",
  "provider",
  "network",
])

/** Codes the runs API / harness use that the bubble shows as another kind. */
const ALIASES: Readonly<Record<string, MessageErrorCode>> = {
  // The model provider failed or is unreachable / unconfigured.
  upstream: "provider",
  unavailable: "provider",
}

/**
 * Map a wire error code (a non-2xx `ApiError.code`, or `RUN_ERROR.code`)
 * onto a `MessageError`. Unknown codes — `run_id_conflict`,
 * `run_already_resumed`, `invalid_state`, `not_found`, `limit_reached`,
 * `max_steps`, `worker_lost`, … — become `unknown` with the server's
 * message as `detail`. A 429 is always `rate_limit`, a bare 401 `auth`.
 */
export function messageErrorFor(
  code: string | undefined,
  opts: { status?: number; detail?: string; model?: string } = {},
): MessageError {
  let mapped: MessageErrorCode
  if (code && KNOWN.has(code as MessageErrorCode)) mapped = code as MessageErrorCode
  else if (code && ALIASES[code]) mapped = ALIASES[code]
  else if (opts.status === 429) mapped = "rate_limit"
  else if (opts.status === 401) mapped = "auth"
  else mapped = "unknown"
  const out: MessageError = { code: mapped }
  if (opts.status) out.status = opts.status
  if (opts.model) out.model = opts.model
  if (opts.detail) out.detail = opts.detail
  return out
}

/** Read a non-2xx response's `{code, message}` envelope into a `RunsError`. */
export async function runsErrorFromResponse(res: Response): Promise<RunsError> {
  let code: string | undefined
  let message: string | undefined
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown; detail?: unknown }
    if (typeof body.code === "string") code = body.code
    if (typeof body.message === "string") message = body.message
    else if (typeof body.detail === "string") message = body.detail
  } catch {
    // not JSON — keep the status only
  }
  return new RunsError(
    "http",
    code ?? (res.status === 429 ? "rate_limit" : res.status === 401 ? "auth" : "unknown"),
    message ?? `Request failed (${res.status}).`,
    res.status,
  )
}
