"""Request-body size cap — a pure ASGI middleware.

FastAPI reads (and, for multipart, spools to a temp file) the whole
request body while solving a route's parameters — BEFORE the
`get_current_user` dependency rejects an unauthenticated caller. Without
a cap at the transport layer, anyone could stream an unbounded file part
to `/tmp` or make a JSON route buffer gigabytes, auth or not.

This middleware enforces a per-path byte limit ahead of the app:

  - a declared `Content-Length` over the limit → 413 without reading a
    byte of the body;
  - a chunked / undeclared body is counted as it streams through
    `receive`; the chunk that crosses the limit is never handed to the
    app — `receive` raises instead, and the client gets 413 (whatever
    response the app tried to send after its body read failed is
    discarded).

It is pure ASGI (not `BaseHTTPMiddleware`) so streaming responses — the
SSE chat stream — pass through untouched.
"""

from __future__ import annotations

import json
from collections.abc import Callable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .error_envelope import error_body
from .settings import Settings

__all__ = ["BodySizeLimitMiddleware", "BodyTooLargeError", "body_limit_for"]

# Multipart framing (boundaries, part headers, the filename) on top of
# the file itself — same slack as the Next.js route's `EXTRACT_BODY_MAX`.
_MULTIPART_OVERHEAD = 64 * 1024

# `/v1/extract-table`: `reportText` ≤ 100k chars + ≤ 100 sources (~4.3k
# chars each) at ≤ 3 UTF-8 bytes per char, plus headroom — the Next.js
# route's `EXTRACT_TABLE_BODY_MAX`.
_EXTRACT_TABLE_BODY_MAX = 2 * 1024 * 1024

# `/v1/share` (create): a kind + one uuid — the Next.js route's
# `SHARE_BODY_MAX`.
_SHARE_BODY_MAX = 16 * 1024
# `/v1/tasks/schedules[/{id}]`: name + prompt + system prompt top out
# around 40 KB — the Next.js routes' `SCHEDULE_BODY_MAX`.
_SCHEDULE_BODY_MAX = 256 * 1024
_SCHEDULES_PATH = "/v1/tasks/schedules"
# Per-route caps mirroring the Next.js routes: `/v1/embed` (`text` ≤ 1.2M
# chars at ≤ 3 UTF-8 bytes each — `EMBED_BODY_MAX`), `/v1/memory/extract`
# (`turnText` ≤ 50k chars — `MEMORY_EXTRACT_BODY_MAX`), `/v1/csp-report`
# (`CSP_REPORT_MAX_BYTES`; it is public, so the cap matters most there).
_FIXED_PATH_LIMITS = {
    # The editor AI routes (wave 9): `AI_COMMAND_BODY_MAX` (a large
    # document, rendered to text) and `AI_COMPLETE_BODY_MAX`.
    "/v1/ai/command": 32 * 1024 * 1024,
    "/v1/ai/complete": 256 * 1024,
    "/v1/embed": 4 * 1024 * 1024,
    "/v1/memory/extract": 256 * 1024,
    "/v1/csp-report": 16 * 1024,
}

# Routes whose JSON body legitimately carries a whole conversation.
_CONVERSATION_PATHS = frozenset({"/v1/summarize", "/v1/runs"})


def body_limit_for(settings: Settings) -> Callable[[str], int]:
    """Per-path limits:
    - `/v1/extract` — the upload cap (`EXTRACT_MAX_BYTES`) plus
      multipart overhead; the route still enforces the file cap itself;
    - `/v1/summarize`, `/v1/runs` — `CHAT_BODY_MAX_BYTES`;
    - `/v1/extract-table` — 2 MiB, as on the Next.js route;
    - `/v1/share` — 16 KiB, as on the Next.js route;
    - `/v1/tasks/schedules[/{id}]` — 256 KiB, as on the Next.js routes;
    - `/v1/embed` 4 MiB, `/v1/memory/extract` 256 KiB, `/v1/csp-report`
      16 KiB, `/v1/ai/command` 32 MiB, `/v1/ai/complete` 256 KiB — as on
      the Next.js routes;
    - everything else — `REQUEST_BODY_MAX_BYTES`."""
    extract_limit = settings.EXTRACT_MAX_BYTES + _MULTIPART_OVERHEAD
    chat_limit = settings.CHAT_BODY_MAX_BYTES
    default_limit = settings.REQUEST_BODY_MAX_BYTES

    def limit_for(path: str) -> int:
        normalised = path.rstrip("/") or "/"
        if normalised == "/v1/extract":
            return extract_limit
        if normalised in _CONVERSATION_PATHS:
            return chat_limit
        if normalised == "/v1/extract-table":
            return _EXTRACT_TABLE_BODY_MAX
        if normalised == "/v1/share":
            return _SHARE_BODY_MAX
        if normalised == _SCHEDULES_PATH or normalised.startswith(_SCHEDULES_PATH + "/"):
            return _SCHEDULE_BODY_MAX
        if normalised in _FIXED_PATH_LIMITS:
            return _FIXED_PATH_LIMITS[normalised]
        return default_limit

    return limit_for


_MESSAGE_TOO_LARGE = "Request body too large."


class BodyTooLargeError(Exception):
    """Raised from the wrapped `receive` once the body passes its limit."""


class BodySizeLimitMiddleware:
    """Cap every HTTP request body at `limit_for(path)` bytes."""

    def __init__(self, app: ASGIApp, *, limit_for: Callable[[str], int]) -> None:
        self.app = app
        self.limit_for = limit_for

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.limit_for(str(scope.get("path", "")))
        declared = _content_length(scope)
        if declared == -1:
            await _send_error(send, 400, "invalid_request", "Invalid Content-Length header.")
            return
        if declared is not None and declared > limit:
            await _send_error(send, 413, "payload_too_large", _MESSAGE_TOO_LARGE)
            return

        received = 0
        exceeded = False
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            if exceeded:
                raise BodyTooLargeError
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise BodyTooLargeError
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal response_started
            if exceeded and not response_started:
                # The app's reaction to the failed body read (FastAPI
                # turns it into a 400) — replaced by our 413 below.
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except BodyTooLargeError:
            if response_started:
                raise
        except Exception:
            if not exceeded or response_started:
                raise
        if exceeded and not response_started:
            await _send_error(send, 413, "payload_too_large", _MESSAGE_TOO_LARGE)


def _content_length(scope: Scope) -> int | None:
    """Declared body length; `None` when absent, `-1` when malformed
    (non-numeric, negative, or conflicting repeated headers)."""
    values = {
        value.decode("latin-1").strip()
        for key, value in scope.get("headers", [])
        if key.lower() == b"content-length"
    }
    if not values:
        return None
    if len(values) != 1:
        return -1
    raw = values.pop()
    if not raw.isdigit():
        return -1
    return int(raw)


async def _send_error(send: Send, status: int, code: str, message: str) -> None:
    """Answer with the flat `{code, message}` envelope (`error_envelope`)."""
    body = json.dumps(error_body(code, message)).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"connection", b"close"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
