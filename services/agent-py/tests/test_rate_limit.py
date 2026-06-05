"""Tests for the in-process sliding-window rate limiter that backs
the `/v1/chat` per-IP gate. Pure logic — no HTTP, no FastAPI."""

from __future__ import annotations

import time
from unittest.mock import patch

from agent_py.rate_limit import SlidingWindow


def test_first_request_is_allowed() -> None:
    limit = SlidingWindow(window_ms=60_000, max=3)
    v = limit.consume("ip-1")
    assert v.allowed is True
    assert v.retry_after_sec == 0


def test_max_requests_fit_inside_the_window() -> None:
    limit = SlidingWindow(window_ms=60_000, max=3)
    assert limit.consume("ip-1").allowed is True
    assert limit.consume("ip-1").allowed is True
    assert limit.consume("ip-1").allowed is True


def test_over_max_returns_deny_with_retry_after() -> None:
    """The fourth request inside the window is denied; the
    `retry_after_sec` is a positive integer roughly equal to the
    remaining window time."""
    limit = SlidingWindow(window_ms=10_000, max=3)
    for _ in range(3):
        assert limit.consume("ip-1").allowed is True
    v = limit.consume("ip-1")
    assert v.allowed is False
    assert 1 <= v.retry_after_sec <= 10  # rounds up; window is 10s


def test_keys_are_independent() -> None:
    """Hammering one key doesn't affect another — that's the whole
    point of having a key."""
    limit = SlidingWindow(window_ms=60_000, max=2)
    assert limit.consume("a").allowed is True
    assert limit.consume("a").allowed is True
    assert limit.consume("a").allowed is False
    # Different key starts fresh.
    assert limit.consume("b").allowed is True


def test_old_entries_drop_out_of_the_window() -> None:
    """Once `window_ms` ms have elapsed, prior entries no longer
    count against the cap. We simulate by patching `time.monotonic`."""
    limit = SlidingWindow(window_ms=1_000, max=2)
    start = time.monotonic()
    with patch("agent_py.rate_limit.time.monotonic") as mock_time:
        mock_time.return_value = start
        assert limit.consume("ip-1").allowed is True
        assert limit.consume("ip-1").allowed is True
        assert limit.consume("ip-1").allowed is False
        # 1.1s later — the first two entries are outside the window.
        mock_time.return_value = start + 1.1
        v = limit.consume("ip-1")
        assert v.allowed is True
        assert v.retry_after_sec == 0


def test_reset_clears_all_buckets() -> None:
    """The test seam — calling `.reset()` drops state so subsequent
    consume calls start fresh."""
    limit = SlidingWindow(window_ms=60_000, max=1)
    assert limit.consume("ip-1").allowed is True
    assert limit.consume("ip-1").allowed is False
    limit.reset()
    assert limit.consume("ip-1").allowed is True


def test_retry_after_sec_is_at_least_one() -> None:
    """Even if the math floor returns 0 (we're milliseconds away from
    the window expiring), we round up to 1 so the client always waits
    at least one second — keeps `Retry-After: 0` out of the response."""
    limit = SlidingWindow(window_ms=1_000, max=1)
    start = time.monotonic()
    with patch("agent_py.rate_limit.time.monotonic") as mock_time:
        mock_time.return_value = start
        limit.consume("ip-1")
        # 999ms into the window — 1ms left. Verdict should still
        # advertise at least 1s.
        mock_time.return_value = start + 0.999
        v = limit.consume("ip-1")
        assert v.allowed is False
        assert v.retry_after_sec >= 1


# --- rate_limit_key ---------------------------------------------------


def test_rate_limit_key_prefers_forwarded_for() -> None:
    """`X-Forwarded-For` is the cdn/proxy convention; first entry is
    the original client."""
    from unittest.mock import MagicMock

    from agent_py.rate_limit import rate_limit_key

    req = MagicMock()
    req.headers = {"x-forwarded-for": "203.0.113.42, 10.0.0.1"}
    req.client = MagicMock(host="127.0.0.1")
    assert rate_limit_key(req) == "203.0.113.42"


def test_rate_limit_key_falls_back_to_client_host() -> None:
    """No XFF header → use the socket peer."""
    from unittest.mock import MagicMock

    from agent_py.rate_limit import rate_limit_key

    req = MagicMock()
    req.headers = {}
    req.client = MagicMock(host="10.0.0.1")
    assert rate_limit_key(req) == "10.0.0.1"


def test_rate_limit_key_default_when_unknown() -> None:
    """Neither header nor client → the global `"default"` bucket so an
    unconfigured deploy still limits abuse rather than going
    unbounded."""
    from unittest.mock import MagicMock

    from agent_py.rate_limit import rate_limit_key

    req = MagicMock()
    req.headers = {}
    req.client = None
    assert rate_limit_key(req) == "default"
