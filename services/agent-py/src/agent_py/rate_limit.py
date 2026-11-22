"""Sliding-window per-key rate limiter.

In-process; not durable across restarts and not shared across worker
processes — fine for our scale, and the worst case is a small leak in
rate-limit accuracy after cold starts, not a security gap (the SSRF
guard, auth middleware, and per-tool caps all still apply).

The window is "the most recent ``window_ms`` ms ago." Each successful
check pushes ``now`` into the key's bucket and drops anything older
than the window. When the bucket has ``max`` entries the check
returns ``allowed=False`` with a ``retry_after_sec`` hint computed
from the oldest entry's age.

Python mirror of ``lib/server/rate-limit.ts``.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass

from fastapi import Request

from .settings import Settings, get_settings
from .tools.registry import BudgetVerdict

__all__ = [
    "DEFAULT_IMAGE_GEN_PER_MINUTE",
    "IMAGE_GEN_BUDGET",
    "MAX_IMAGE_GEN_PER_MINUTE",
    "WEB_TOOL_BUDGET",
    "WEB_TOOL_PER_MINUTE",
    "RateLimitVerdict",
    "SlidingWindow",
    "ToolBudgets",
    "image_gen_per_minute",
    "rate_limit_key",
]


@dataclass(frozen=True)
class RateLimitVerdict:
    allowed: bool
    """Seconds the client should wait before retrying. 0 when allowed."""
    retry_after_sec: int


_DEFAULT_MAX_BUCKETS = 10_000


class SlidingWindow:
    """In-process sliding-window limiter. Construct once at module
    scope (so the buckets survive across requests on the same worker);
    call ``.consume(key)`` at the start of every request you want to
    rate-limit.

    Memory is bounded two ways (mirrors the TS limiter): a sweep (at
    most once per ``window_ms``, run lazily from ``consume``) drops
    buckets whose newest entry has aged out of the window, and a hard
    ``max_buckets`` cap evicts the least-recently-used buckets when a
    new key would exceed it. Dict insertion order doubles as LRU order:
    every touch re-inserts the key."""

    __slots__ = ("_buckets", "_last_sweep", "max", "max_buckets", "window_ms")

    def __init__(
        self, *, window_ms: int, max: int, max_buckets: int = _DEFAULT_MAX_BUCKETS
    ) -> None:
        self.window_ms = window_ms
        self.max = max
        self.max_buckets = max_buckets if max_buckets > 0 else 1
        self._buckets: dict[str, list[float]] = {}
        self._last_sweep = _now_ms()

    def _sweep(self, now: float) -> None:
        """Drop every bucket with no entry inside the window. Buckets
        are sorted ascending, so the last entry is the newest."""
        self._last_sweep = now
        stale = [
            key
            for key, bucket in self._buckets.items()
            if not bucket or now - bucket[-1] >= self.window_ms
        ]
        for key in stale:
            del self._buckets[key]

    def consume(self, key: str) -> RateLimitVerdict:
        now = _now_ms()
        if now - self._last_sweep >= self.window_ms:
            self._sweep(now)
        bucket = self._buckets.pop(key, [])
        # Drop entries outside the window.
        fresh = [t for t in bucket if now - t < self.window_ms]
        if len(fresh) >= self.max:
            self._buckets[key] = fresh
            oldest = fresh[0]
            retry_after_ms = self.window_ms - (now - oldest)
            return RateLimitVerdict(
                allowed=False,
                retry_after_sec=max(1, math.ceil(retry_after_ms / 1000)),
            )
        fresh.append(now)
        if len(self._buckets) >= self.max_buckets:
            self._sweep(now)
            while len(self._buckets) >= self.max_buckets:
                # Oldest insertion = least recently used.
                del self._buckets[next(iter(self._buckets))]
        self._buckets[key] = fresh
        return RateLimitVerdict(allowed=True, retry_after_sec=0)

    def reset(self) -> None:
        """Test seam — drop all buckets. Production callers never need
        this; tests use it between cases to keep state from bleeding."""
        self._buckets.clear()
        self._last_sweep = _now_ms()

    def size(self) -> int:
        """Test seam — number of tracked buckets."""
        return len(self._buckets)


def _now_ms() -> float:
    return time.monotonic() * 1000.0


# --- Per-IP tool budgets (the Next chat route's `chatWebToolLimit` /
# `chatImageGenLimit`) -------------------------------------------------------

#: Budget kinds a tool passes to `RunToolContext.consume_budget`.
WEB_TOOL_BUDGET = "webTool"
"""webSearch + webFetch + searchFiles, one shared bucket — as the Next
chat route gives every non-image skill `consumeWebToolBudget`."""
IMAGE_GEN_BUDGET = "imageGen"

#: The Next route's fixed web-tool window: 20 outbound ops per IP per minute.
WEB_TOOL_PER_MINUTE = 20
DEFAULT_IMAGE_GEN_PER_MINUTE = 5
MAX_IMAGE_GEN_PER_MINUTE = 60


def image_gen_per_minute(raw: str) -> int:
    """`MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE`, read as the Next route reads
    it: not a positive number → 5; otherwise floored and capped at 60."""
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_IMAGE_GEN_PER_MINUTE
    if not math.isfinite(value) or value <= 0:
        return DEFAULT_IMAGE_GEN_PER_MINUTE
    return max(1, min(math.floor(value), MAX_IMAGE_GEN_PER_MINUTE))


class ToolBudgets:
    """The per-IP tool budgets of interactive runs, one sliding window per
    kind (60 s): `WEB_TOOL_BUDGET` (`web_tool_per_minute`, Next's 20) and
    `IMAGE_GEN_BUDGET` (`image_gen_per_minute`). Counted per tool
    invocation, keyed on the run's `client_key` for every caller — the
    Next route keys signed-in users on their IP too. An unknown kind is
    not limited. Call the instance: `budgets(client_key, kind)`."""

    def __init__(self, *, web_tool_per_minute: int, image_gen_per_minute: int) -> None:
        self._windows: dict[str, SlidingWindow] = {
            WEB_TOOL_BUDGET: SlidingWindow(window_ms=60_000, max=max(1, web_tool_per_minute)),
            IMAGE_GEN_BUDGET: SlidingWindow(window_ms=60_000, max=max(1, image_gen_per_minute)),
        }

    @classmethod
    def from_settings(cls, settings: Settings) -> ToolBudgets:
        return cls(
            web_tool_per_minute=settings.WEB_TOOL_RATE_LIMIT_PER_MINUTE,
            image_gen_per_minute=image_gen_per_minute(settings.MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE),
        )

    def __call__(self, client_key: str | None, kind: str) -> BudgetVerdict:
        window = self._windows.get(kind)
        if window is None:
            return BudgetVerdict(allowed=True)
        # No key (never on an interactive run — the router always sets
        # one) shares `rate_limit_key`'s last-resort bucket.
        verdict = window.consume(client_key or "default")
        return BudgetVerdict(allowed=verdict.allowed, retry_after_sec=verdict.retry_after_sec)


def rate_limit_key(
    request: Request,
    *,
    trusted_proxy_hops: int | None = None,
    client_ip_header: str | None = None,
) -> str:
    """Derive the per-client rate-limit key.

    Precedence:
      1. ``CLIENT_IP_HEADER`` (e.g. ``cf-connecting-ip``) when configured
         and present — a platform header the edge overwrites, so it
         can't be spoofed by the client.
      2. ``X-Forwarded-For``, taking the entry ``TRUSTED_PROXY_HOPS``
         places from the right. Each trusted proxy *appends* the address
         it saw, so the right-hand entries are trustworthy and the
         left-hand ones are whatever the client sent. Taking the
         leftmost entry (the old behaviour) let any caller pick their
         own bucket by sending ``X-Forwarded-For: <random>``.
      3. The socket peer.
      4. ``"default"`` so an unconfigured deploy still limits abuse to
         one global rate rather than going unbounded.

    Keyword args are test seams; production reads them from settings.
    """
    if trusted_proxy_hops is None or client_ip_header is None:
        settings = get_settings()
        if trusted_proxy_hops is None:
            trusted_proxy_hops = settings.TRUSTED_PROXY_HOPS
        if client_ip_header is None:
            client_ip_header = settings.CLIENT_IP_HEADER

    if client_ip_header:
        platform_ip = (request.headers.get(client_ip_header) or "").strip()
        if platform_ip:
            return platform_ip

    if trusted_proxy_hops > 0:
        # `headers.get` returns only the FIRST `X-Forwarded-For` line;
        # a proxy that adds its own line instead of appending to the
        # client's would leave the client-controlled line as the key.
        # Join every line in order, then split on commas.
        forwarded = ",".join(request.headers.getlist("x-forwarded-for"))
        if forwarded:
            entries = [e.strip() for e in forwarded.split(",") if e.strip()]
            if entries:
                # Fewer entries than trusted hops means the chain is
                # shorter than configured; every entry present was
                # still appended by a trusted proxy, so the leftmost
                # one is the best (and non-spoofable) answer.
                index = max(0, len(entries) - trusted_proxy_hops)
                return entries[index]

    client = request.client
    if client is not None and client.host:
        return client.host
    return "default"
