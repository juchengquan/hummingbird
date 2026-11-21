"""HTTP error categorisation for JSON (non-streaming) AI routes.

Port of `categorizeError` / `upstreamStatus` in `lib/shared/api-errors.ts`:
maps a raised provider error to a stable `(status, code, message)` triple
so a route can answer with the same status + `code` the Next.js route
would. `chat.categorize_provider_error` is the SSE-stream sibling (it
buckets into the four in-band error codes and never picks a status).

One case of the TS original is not ported: `AbortError` → `408 aborted`.
The Next.js routes forward `req.signal` into the model call, so a client
disconnect surfaces as an `AbortError`; FastAPI doesn't cancel a handler
on disconnect, so there is no equivalent exception to map here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from .model_allowlist import UnknownModelError

ApiErrorCode = Literal[
    "rate_limit",
    "context_window",
    "invalid_model",
    "unknown_model",
    "auth",
    "provider",
    "unknown",
]


@dataclass(frozen=True)
class CategorizedError:
    status: int
    code: ApiErrorCode
    message: str

    def to_detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


# Where an HTTP status may appear in a provider error message. Anchored so
# a 3-digit number elsewhere in the text (a token count, a request id, a
# model name like `…-400b`) isn't read as a status. Same patterns as
# `STATUS_IN_MESSAGE` in the TS original.
_STATUS_IN_MESSAGE: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\s*(\d{3})\b"),  # "429 Too Many Requests", "401"
    re.compile(r"\bhttp(?:/[\d.]+)?\s*[:(]?\s*(\d{3})\b", re.IGNORECASE),  # "HTTP 502"
    re.compile(r"\bstatus(?:\s*code)?\s*[:=]?\s*(\d{3})\b", re.IGNORECASE),  # "status 429"
    re.compile(r"\b(?:error|code)\s*[:=]?\s*(\d{3})\b", re.IGNORECASE),  # "Error 503"
)

_RATE_LIMIT_RE = re.compile(r"rate.?limit|quota|too many requests")
_CONTEXT_WINDOW_RE = re.compile(
    r"prompt is too long|context.?window|context.?length|maximum.*context"
    r"|maximum.*tokens|too many tokens|input is too long|exceeds.*token|reduce.*input"
)
_INVALID_MODEL_RE = re.compile(r"invalid.*model|model.*not.found|unknown model")
_AUTH_RE = re.compile(r"unauthor|forbidden")
_PROVIDER_RE = re.compile(r"bad gateway|provider|upstream")


def _is_http_error_status(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 400 <= value <= 599


def upstream_status(exc: BaseException, message: str) -> int | None:
    """The upstream HTTP status, or None. A numeric `status_code` /
    `status` attribute wins (the Anthropic SDK's `APIStatusError`
    carries `status_code`, the AI SDK's `APICallError` the camelCase
    `statusCode` the TS original reads); otherwise only anchored
    mentions in the message count. 4xx/5xx only."""
    for attr in ("status_code", "statusCode", "status"):
        value = getattr(exc, attr, None)
        if _is_http_error_status(value):
            assert isinstance(value, int)
            return value
    for pattern in _STATUS_IN_MESSAGE:
        match = pattern.search(message)
        if match:
            n = int(match.group(1))
            if _is_http_error_status(n):
                return n
    return None


def categorize_error(exc: BaseException) -> CategorizedError:
    """Bucket a raised error into the route's HTTP answer. Order and
    patterns follow `categorizeError` in `lib/shared/api-errors.ts`."""
    message = str(exc) or "Unknown error"

    if isinstance(exc, UnknownModelError):
        return CategorizedError(400, "unknown_model", message)

    lower = message.lower()
    status = upstream_status(exc, message)

    if _RATE_LIMIT_RE.search(lower) or status == 429:
        return CategorizedError(429, "rate_limit", message)
    # Context-window busts surface as 400s with characteristic phrases.
    # Detect them BEFORE the generic invalid_model 400 bucket.
    if _CONTEXT_WINDOW_RE.search(lower):
        return CategorizedError(400, "context_window", message)
    if _INVALID_MODEL_RE.search(lower) or status == 400:
        return CategorizedError(400, "invalid_model", message)
    if _AUTH_RE.search(lower) or status in (401, 403):
        return CategorizedError(401, "auth", message)
    if _PROVIDER_RE.search(lower) or status in (502, 503, 504):
        return CategorizedError(502, "provider", message)
    return CategorizedError(500, "unknown", message)


__all__ = ["ApiErrorCode", "CategorizedError", "categorize_error", "upstream_status"]
