"""The flat error envelope every non-streaming agent-py error answers with.

The frontend (`lib/client/api-client.ts`) and the contract
(`packages/contract/openapi.yaml`, `ApiError`) read an error body as
`{ "code": <stable machine code>, "message": <human text> }`, plus any
extra fields a route adds (`issues` on validation errors, `status` on a
URL-fetch failure, `reason` on a blocked MCP URL, ...). FastAPI's
defaults answer `{ "detail": ... }` instead, so `install_error_handlers`
replaces them:

- `HTTPException` (FastAPI's and Starlette's — routing 404 / 405 too):
  - `detail={"code": ..., "message": ...}` — the agent-py convention
    (`api_errors.py`, `routers/files.py`) — is returned as-is, flat;
  - a string `detail` becomes `{code: code_for_status(status), message}`;
  - the status code and the exception's headers (`WWW-Authenticate`,
    `Retry-After`) are kept.
- `RequestValidationError` → 422 (status unchanged)
  `{code: "invalid_request", message: <first issue>, issues: [...]}`.
- Any other uncaught exception → 500 `{code: "unknown", ...}` with a
  generic message (the exception itself is logged, never echoed).

Hand-built responses outside the handler (the body-size middleware)
build their body with `error_body` so the shape cannot drift.

SSE in-stream error events (`/v1/chat`) are a separate protocol and are
not touched here.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from http import HTTPStatus
from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.utils import is_body_allowed_for_status_code
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse, Response

logger = structlog.get_logger(__name__)

__all__ = [
    "INTERNAL_ERROR_MESSAGE",
    "STATUS_CODES",
    "code_for_status",
    "error_body",
    "flatten_detail",
    "install_error_handlers",
    "validation_error_body",
]

#: Status → `code` for an error raised with a plain-string `detail` (or
#: none). The single place this mapping lives. Codes match what the
#: Next.js routes answer for the same status (`lib/shared/api-errors.ts`,
#: `lib/server/read-body-capped.ts`, `app/api/**/route.ts`):
#: 401 `auth` (resource routes' missing / rejected token; `auth_required`
#: is reserved for `REQUIRE_AUTH_FOR_AI` and is always raised explicitly),
#: 413 `payload_too_large`, 429 `rate_limit` (the `ApiErrorCode` the AI
#: routes use), 503 `unavailable` (backend misconfigured).
STATUS_CODES: Mapping[int, str] = {
    400: "invalid_request",
    401: "auth",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    408: "timeout",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_content_type",
    422: "invalid_request",
    429: "rate_limit",
    500: "unknown",
    502: "provider",
    503: "unavailable",
    504: "timeout",
}

#: Body message for an uncaught exception — deliberately generic.
INTERNAL_ERROR_MESSAGE = "Internal server error."


def code_for_status(status: int) -> str:
    """The `code` for `status`: the table above, else `invalid_request`
    for any other 4xx and `unknown` for anything else."""
    code = STATUS_CODES.get(status)
    if code is not None:
        return code
    return "invalid_request" if 400 <= status < 500 else "unknown"


def error_body(code: str, message: str, **extra: Any) -> dict[str, Any]:
    """`{code, message, **extra}` — the flat envelope."""
    return {"code": code, "message": message, **extra}


def _default_message(status: int) -> str:
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return "Request failed."


def flatten_detail(status: int, detail: Any) -> dict[str, Any]:
    """Turn an `HTTPException.detail` into the flat envelope.

    - a mapping with string `code` and `message` → returned as-is (extra
      keys kept);
    - a mapping missing either → the missing one is filled in (code from
      the status, message from the status phrase), other keys kept;
    - a non-empty string → `{code: code_for_status(status), message}`;
    - anything else (None, a list, ...) → the status phrase as message,
      with a list kept under `issues`.
    """
    if isinstance(detail, Mapping):
        body = {str(k): v for k, v in detail.items()}
        if not isinstance(body.get("code"), str) or not body["code"]:
            body["code"] = code_for_status(status)
        if not isinstance(body.get("message"), str):
            body["message"] = _default_message(status)
        return body
    if isinstance(detail, str) and detail:
        return error_body(code_for_status(status), detail)
    extra: dict[str, Any] = {}
    if isinstance(detail, list):
        extra["issues"] = detail
    return error_body(code_for_status(status), _default_message(status), **extra)


def _format_loc(loc: Sequence[Any]) -> str:
    return ".".join(str(part) for part in loc)


def validation_error_body(errors: Sequence[Any]) -> dict[str, Any]:
    """The 422 body for a request-validation failure.

    `issues` keeps only `loc` / `msg` / `type` of each Pydantic error —
    `input` (an echo of the caller's data, possibly large or sensitive)
    and `ctx` (may hold non-JSON values) are dropped. `message` names
    the first issue, like the Next routes' `issues[0].message`.
    """
    issues: list[dict[str, Any]] = []
    for err in errors:
        if not isinstance(err, Mapping):
            continue
        loc = err.get("loc") or ()
        issues.append(
            {
                "loc": [p if isinstance(p, int | str) else str(p) for p in loc],
                "msg": str(err.get("msg", "")),
                "type": str(err.get("type", "")),
            }
        )
    if issues:
        first = issues[0]
        where = _format_loc(first["loc"])
        message = f"{where}: {first['msg']}" if where else first["msg"]
        if len(issues) > 1:
            message += f" (+{len(issues) - 1} more)"
    else:
        message = "Invalid request."
    return error_body(code_for_status(422), message, issues=issues)


async def _http_exception_handler(_request: Request, exc: Exception) -> Response:
    assert isinstance(exc, StarletteHTTPException)
    headers = getattr(exc, "headers", None)
    if not is_body_allowed_for_status_code(exc.status_code):
        return Response(status_code=exc.status_code, headers=headers)
    return JSONResponse(
        flatten_detail(exc.status_code, exc.detail),
        status_code=exc.status_code,
        headers=headers,
    )


async def _validation_exception_handler(_request: Request, exc: Exception) -> Response:
    assert isinstance(exc, RequestValidationError)
    return JSONResponse(validation_error_body(exc.errors()), status_code=422)


async def _unhandled_exception_handler(request: Request, exc: Exception) -> Response:
    # Starlette's ServerErrorMiddleware re-raises after sending this, so
    # the server still logs the traceback; this line adds the route.
    logger.error("http.unhandled_exception", path=request.url.path, error=type(exc).__name__)
    return JSONResponse(error_body(code_for_status(500), INTERNAL_ERROR_MESSAGE), status_code=500)


#: What the 422 body really is — replaces FastAPI's auto-documented
#: `HTTPValidationError` (`{detail: [...]}`) in `/openapi.json`, so the
#: code-first TS types (`lib/shared/agent-py-types.generated.ts`) match
#: the wire.
_VALIDATION_ERROR_SCHEMA: dict[str, Any] = {
    "title": "HTTPValidationError",
    "type": "object",
    "description": (
        "Request validation failed: the flat error envelope with "
        "`code: invalid_request` and the issues found."
    ),
    "required": ["code", "message"],
    "properties": {
        "code": {"type": "string", "title": "Code"},
        "message": {"type": "string", "title": "Message"},
        "issues": {
            "type": "array",
            "title": "Issues",
            "items": {"$ref": "#/components/schemas/ValidationError"},
        },
    },
}


def _document_flat_validation_errors(app: FastAPI) -> None:
    original = app.openapi

    def openapi() -> dict[str, Any]:
        schema = original()  # cached on app.openapi_schema after the first call
        schemas = schema.get("components", {}).get("schemas", {})
        if "HTTPValidationError" in schemas:
            schemas["HTTPValidationError"] = _VALIDATION_ERROR_SCHEMA
        return schema

    app.openapi = openapi  # type: ignore[method-assign]


def install_error_handlers(app: FastAPI) -> None:
    """Replace FastAPI's `{detail}` error responses with the flat envelope
    (and document the 422 body as it now is)."""
    # Starlette's HTTPException is FastAPI's base class, so this one
    # registration covers both — and routing's own 404 / 405.
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
    _document_flat_validation_errors(app)
