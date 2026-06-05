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

__all__ = [
    "RateLimitVerdict",
    "SlidingWindow",
    "rate_limit_key",
]


@dataclass(frozen=True)
class RateLimitVerdict:
    allowed: bool
    """Seconds the client should wait before retrying. 0 when allowed."""
    retry_after_sec: int


class SlidingWindow:
    """In-process sliding-window limiter. Construct once at module
    scope (so the buckets survive across requests on the same worker);
    call ``.consume(key)`` at the start of every request you want to
    rate-limit."""

    __slots__ = ("_buckets", "max", "window_ms")

    def __init__(self, *, window_ms: int, max: int) -> None:
        self.window_ms = window_ms
        self.max = max
        self._buckets: dict[str, list[float]] = {}

    def consume(self, key: str) -> RateLimitVerdict:
        now = time.monotonic() * 1000.0
        bucket = self._buckets.get(key, [])
        # Drop entries outside the window.
        fresh = [t for t in bucket if now - t < self.window_ms]
        if len(fresh) >= self.max:
            oldest = fresh[0]
            retry_after_ms = self.window_ms - (now - oldest)
            return RateLimitVerdict(
                allowed=False,
                retry_after_sec=max(1, math.ceil(retry_after_ms / 1000)),
            )
        fresh.append(now)
        self._buckets[key] = fresh
        return RateLimitVerdict(allowed=True, retry_after_sec=0)

    def reset(self) -> None:
        """Test seam — drop all buckets. Production callers never need
        this; tests use it between cases to keep state from bleeding."""
        self._buckets.clear()


def rate_limit_key(request: Request) -> str:
    """Standard key derivation. Prefers `X-Forwarded-For` (the deploy
    proxy fills it in); falls back to the socket peer when present;
    falls back to ``"default"`` so an unconfigured deploy still limits
    abuse to one global rate rather than going unbounded.

    Mirrors `rateLimitKey` in `lib/server/rate-limit.ts`.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # Take the leftmost entry — that's the original client per the
        # XFF convention. Anything to the right is proxy chain.
        first, _, _ = forwarded.partition(",")
        first = first.strip()
        if first:
            return first
    client = request.client
    if client is not None and client.host:
        return client.host
    return "default"
