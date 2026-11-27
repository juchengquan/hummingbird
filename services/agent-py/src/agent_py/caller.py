"""Who is calling a non-chat endpoint: a signed-in user or an anonymous
caller (wave 12, Q123/Q134 of `docs/PLAN-frontend-backend-split.md`).

The account-bound endpoints (share, schedules, memory extract, the
stored-file links, cloud MCP, `/v1/mcp/server`) keep `get_current_user`.
The ones a signed-out browser uses — URL fetch, summarize, extract,
extract-table, the local-mode MCP proxy, embed — take `optional_caller`:

* an `Authorization` header is verified as on every route — a bad or
  malformed one is `401 auth`, never a fall-back to anonymous;
* without one the caller is anonymous, keyed by client IP
  (`rate_limit_key`, as anonymous runs are);
* anonymous callers are refused `401 auth_required` under
  `REQUIRE_AUTH_FOR_AI` (strict parsing; a malformed flag is a 500, as
  on Next and on runs). `optional_caller_ungated` lets them through and
  says so (`Caller.ai_denied`) — `/v1/extract`, whose text pass spends no
  model budget, only drops its vision pass for them, as Next does.

Anonymous callers get Next's per-IP limits (`AnonymousWindow`); a
signed-in caller's limits are each route's own, unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, NoReturn

import structlog
from fastapi import Depends, Header, HTTPException, Request

from .auth import get_current_user
from .rate_limit import SlidingWindow, rate_limit_key
from .runs.access import RequireAuthConfigError, require_auth_for_ai
from .settings import Settings, get_settings

logger = structlog.get_logger(__name__)

__all__ = [
    "AUTH_REQUIRED_MESSAGE",
    "AnonymousWindow",
    "Caller",
    "optional_caller",
    "optional_caller_ungated",
]

AUTH_REQUIRED_MESSAGE = "Sign in to use AI features on this server."


@dataclass(frozen=True)
class Caller:
    """The caller of a request: `user_id` when signed in, else None."""

    user_id: str | None
    #: The client IP key (`rate_limit_key`) — every caller has one.
    client_key: str
    #: Anonymous under `REQUIRE_AUTH_FOR_AI` (only `optional_caller_ungated`
    #: hands such a caller to a route).
    ai_denied: bool = False

    @property
    def anonymous(self) -> bool:
        return self.user_id is None


def _resolve(request: Request, settings: Settings, authorization: str | None) -> Caller:
    client_key = rate_limit_key(request)
    if authorization is not None:
        claims = get_current_user(authorization, settings)
        return Caller(user_id=str(claims["sub"]), client_key=client_key)
    try:
        gated = require_auth_for_ai(settings)
    except RequireAuthConfigError as exc:
        logger.error("caller.require_auth_config", error=str(exc))
        raise HTTPException(
            status_code=500, detail={"code": "unknown", "message": "Server misconfigured."}
        ) from exc
    return Caller(user_id=None, client_key=client_key, ai_denied=gated)


def optional_caller(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> Caller:
    """The caller; an anonymous one is refused under `REQUIRE_AUTH_FOR_AI`."""
    caller = _resolve(request, settings, authorization)
    if caller.ai_denied:
        raise HTTPException(
            status_code=401,
            detail={"code": "auth_required", "message": AUTH_REQUIRED_MESSAGE},
        )
    return caller


def optional_caller_ungated(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> Caller:
    """The caller, anonymous ones let through under `REQUIRE_AUTH_FOR_AI`
    with `ai_denied` set (the route withholds its model-backed part)."""
    return _resolve(request, settings, authorization)


class AnonymousWindow:
    """A per-IP sliding window (60 s) on anonymous callers only — Next's
    limit for the route. `check` raises `429 rate_limit` + `Retry-After`
    once the caller's IP is over it; a signed-in caller passes uncounted."""

    def __init__(self, *, per_minute: int, message: str) -> None:
        self.per_minute = per_minute
        self.message = message
        self._window = SlidingWindow(window_ms=60_000, max=per_minute)

    def check(self, caller: Caller) -> None:
        if not caller.anonymous:
            return
        verdict = self._window.consume(f"ip:{caller.client_key}")
        if not verdict.allowed:
            raise_rate_limited(self.message, verdict.retry_after_sec)

    def reset(self) -> None:
        """Forget every bucket (tests)."""
        self._window.reset()


def raise_rate_limited(message: str, retry_after_sec: int) -> NoReturn:
    raise HTTPException(
        status_code=429,
        detail={"code": "rate_limit", "message": f"{message} Retry in {retry_after_sec}s."},
        headers={"Retry-After": str(retry_after_sec)},
    )
