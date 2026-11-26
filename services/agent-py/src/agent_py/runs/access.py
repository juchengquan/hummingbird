"""Who may touch a run: run tokens, the sign-in gate and anonymous limits.

Q16 / Q20 of `docs/PLAN-frontend-backend-split.md`:

* **Run tokens.** An anonymous run's only credential is its `runToken`
  (≥ 128 random bits, base64url — `RunToken` in the contract), issued
  once in `startRun`'s `X-Run-Token` response header. The backend keeps
  only its SHA-256 (`RunOwner.anonymous`), so a leaked store holds no
  usable token. `getRun` / `streamRunEvents` / `cancelRun` accept it for
  that run; `startRun` uses a presented token only to recognise an
  idempotent retry of the run it belongs to, or a resume of the
  interrupted run it belongs to (the answering run continues that
  thread under the same token) — any other new run gets a freshly
  minted token.
* **`REQUIRE_AUTH_FOR_AI`** moves here from the Next.js routes, with the
  same strict parsing (`lib/server/auth/require-ai-auth.ts`).
* **Anonymous limits**, per client IP: a start rate, a rolling daily
  budget and a cap on live runs (see `AnonymousLimits`).
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass

from ..auth import auth_configured
from ..rate_limit import RateLimitVerdict, SlidingWindow
from ..settings import Settings

__all__ = [
    "RUN_TOKEN_HEADER",
    "AnonymousLimits",
    "RequireAuthConfigError",
    "is_run_token",
    "mint_run_token",
    "parse_require_auth_flag",
    "require_auth_for_ai",
]

RUN_TOKEN_HEADER = "X-Run-Token"

_RUN_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{22,128}", re.ASCII)


def mint_run_token() -> str:
    """A fresh run token: 192 random bits, base64url without padding
    (32 characters — inside the contract's `RunToken` pattern)."""
    return secrets.token_urlsafe(24)


def is_run_token(value: str) -> bool:
    """Whether `value` has the contract's `RunToken` shape."""
    return _RUN_TOKEN_RE.fullmatch(value) is not None


# --- REQUIRE_AUTH_FOR_AI -------------------------------------------------------


class RequireAuthConfigError(ValueError):
    """`REQUIRE_AUTH_FOR_AI` holds something other than true/false/1/0."""

    def __init__(self, raw: str) -> None:
        super().__init__(f"REQUIRE_AUTH_FOR_AI must be one of true/false/1/0 (got {raw!r}).")


def parse_require_auth_flag(raw: str | None) -> bool:
    """`parseRequireAuthFlag`: unset / empty / `false` / `0` → False,
    `true` / `1` → True (case-insensitive, whitespace ignored), anything
    else raises — a typo must not silently leave anonymous AI open."""
    value = (raw or "").strip().lower()
    if value in ("", "false", "0"):
        return False
    if value in ("true", "1"):
        return True
    raise RequireAuthConfigError(raw or "")


def require_auth_for_ai(settings: Settings) -> bool:
    """True when anonymous runs must be refused: the flag is on **and**
    sign-in is possible (a token can be verified: `SUPABASE_JWT_SECRET`
    or a JWKS URL — the agent-py counterpart of "Supabase configured"). Raises
    `RequireAuthConfigError` on an invalid flag even when it would be
    inert, like `isAiAuthRequired`."""
    if not parse_require_auth_flag(settings.REQUIRE_AUTH_FOR_AI):
        return False
    return auth_configured(settings)


# --- Anonymous limits ------------------------------------------------------------

_DAY_MS = 24 * 60 * 60 * 1000


@dataclass(frozen=True)
class LimitRefusal:
    message: str
    retry_after_sec: int


class AnonymousLimits:
    """Per-IP limits on starting runs (in-process, like every agent-py
    limiter — `rate_limit.py` explains why that is acceptable):

    * `rate` — every caller's starts per minute (`RUNS_RATE_PER_MINUTE`);
    * `anonymous_rate` — anonymous starts per minute;
    * `anonymous_budget` — anonymous starts per rolling 24 h;
    * `anonymous_concurrent` — live anonymous runs at once (checked by the
      caller against the in-memory store, which knows which runs are
      live).

    A start consumes from the windows before the run is created, so a
    refused body (409, 400) still counts — the cheap, conservative
    choice for an abuse limit."""

    def __init__(
        self,
        *,
        rate_per_minute: int,
        anonymous_rate_per_minute: int,
        anonymous_daily_budget: int,
        anonymous_max_concurrent: int,
    ) -> None:
        self.rate = SlidingWindow(window_ms=60_000, max=max(1, rate_per_minute))
        self.anonymous_rate = SlidingWindow(window_ms=60_000, max=max(1, anonymous_rate_per_minute))
        self.anonymous_budget = SlidingWindow(window_ms=_DAY_MS, max=max(1, anonymous_daily_budget))
        self.anonymous_max_concurrent = max(1, anonymous_max_concurrent)

    @staticmethod
    def from_settings(settings: Settings) -> AnonymousLimits:
        return AnonymousLimits(
            rate_per_minute=settings.RUNS_RATE_PER_MINUTE,
            anonymous_rate_per_minute=settings.RUNS_ANONYMOUS_RATE_PER_MINUTE,
            anonymous_daily_budget=settings.RUNS_ANONYMOUS_DAILY_BUDGET,
            anonymous_max_concurrent=settings.RUNS_ANONYMOUS_MAX_CONCURRENT,
        )

    def check_start(
        self, client_key: str, *, anonymous: bool, live_anonymous_runs: int
    ) -> LimitRefusal | None:
        """None when the start may proceed (and is counted); otherwise
        why not."""
        verdict = self.rate.consume(client_key)
        if not verdict.allowed:
            return _refusal("Too many runs started. Slow down and retry.", verdict)
        if not anonymous:
            return None
        if live_anonymous_runs >= self.anonymous_max_concurrent:
            return LimitRefusal("Too many runs in progress. Wait for one to finish, or sign in.", 5)
        verdict = self.anonymous_rate.consume(client_key)
        if not verdict.allowed:
            return _refusal("Too many runs started. Slow down, or sign in.", verdict)
        verdict = self.anonymous_budget.consume(client_key)
        if not verdict.allowed:
            return _refusal("Daily limit for anonymous runs reached. Sign in to continue.", verdict)
        return None

    def check_anonymous_call(self, client_key: str) -> LimitRefusal | None:
        """An anonymous editor AI command (wave 9, Q105): the anonymous
        per-minute and daily windows, shared with anonymous runs."""
        verdict = self.anonymous_rate.consume(client_key)
        if not verdict.allowed:
            return _refusal("Too many AI requests. Slow down, or sign in.", verdict)
        verdict = self.anonymous_budget.consume(client_key)
        if not verdict.allowed:
            return _refusal(
                "Daily limit for anonymous AI requests reached. Sign in to continue.", verdict
            )
        return None


def _refusal(message: str, verdict: RateLimitVerdict) -> LimitRefusal:
    return LimitRefusal(message, verdict.retry_after_sec)
