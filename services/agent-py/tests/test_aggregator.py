"""Tests for the cross-chunk verification path: load_run_events
(store read) and aggregate_from_events (verify pure aggregator)."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from structlog.testing import capture_logs

from agent_py import events, store, verify


def _row(seq: int, step: int, kind: str, payload: dict[str, object]) -> dict[str, object]:
    """Shape of one row from `SELECT seq, step, kind, payload, created_at`."""
    return {
        "seq": seq,
        "step": step,
        "kind": kind,
        "payload": json.dumps(payload),
        "created_at": "2026-06-13T12:00:00Z",
    }


def _pool_with_rows(rows: list[dict[str, object]]) -> MagicMock:
    """Build a MagicMock pool whose `pool.acquire().__aenter__()`
    yields a conn with `fetch = AsyncMock(return_value=rows)`. Mirrors
    the pattern in services/agent-py/tests/test_jobs.py:34-48.
    `conn.execute` is also stubbed because `load_run_events` calls
    `_set_user_context(conn, ...)` first, which executes a
    `SET LOCAL ROLE` statement before the SELECT."""
    conn = MagicMock()
    conn.fetch = AsyncMock(return_value=rows)
    conn.execute = AsyncMock(return_value="SELECT 1")
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=None)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


@pytest.mark.asyncio
async def test_load_run_events_round_trip() -> None:
    """5 events written via `append_event` round-trip through
    `load_run_events` in seq order with all fields preserved."""
    pool = _pool_with_rows(
        [
            _row(1, 0, "status", {"status": "running"}),
            _row(2, 0, "token", {"text": "Hello ", "channel": "text"}),
            _row(3, 0, "token", {"text": "world.", "channel": "text"}),
            _row(
                4,
                0,
                "tool_output",
                {
                    "toolCallId": "t1",
                    "toolName": "webSearch",
                    "summary": "5 results",
                    "results": [{"title": "X", "url": "https://x", "snippet": "snippet X"}],
                },
            ),
            _row(5, 0, "result", {"status": "done", "finalText": "Hello world."}),
        ]
    )
    out = await store.load_run_events(
        pool,  # type: ignore[arg-type]
        run_id="r1",
        user_id="u1",
    )
    assert [e.kind for e in out] == ["status", "token", "token", "tool_output", "result"]
    assert isinstance(out[1], events.TokenEvent)
    assert out[1].text == "Hello "
    assert isinstance(out[3], events.ToolOutputEvent)
    assert out[3].results is not None
    assert out[3].results[0].title == "X"
    assert isinstance(out[4], events.ResultEvent)
    assert out[4].final_text == "Hello world."


@pytest.mark.asyncio
async def test_load_run_events_skips_unknown_kinds() -> None:
    """Unknown kinds are skipped with a warning, not raised."""
    pool = _pool_with_rows(
        [
            _row(1, 0, "status", {"status": "running"}),
            _row(2, 0, "unknown_kind", {"junk": True}),
            _row(3, 0, "token", {"text": "ok", "channel": "text"}),
        ]
    )
    with capture_logs() as logs:
        out = await store.load_run_events(
            pool,  # type: ignore[arg-type]
            run_id="r1",
            user_id="u1",
        )
    assert [e.kind for e in out] == ["status", "token"]
    assert any(
        log.get("event") == "store.unknown_event_kind" and log.get("kind") == "unknown_kind"
        for log in logs
    )


def test_aggregate_from_events_pure() -> None:
    """Build a hand-crafted event list and assert the aggregation
    matches the shape the in-memory accumulator produced."""
    events_list: list[events.TaskEvent] = [
        events.StatusEvent(
            run_id="r1",
            seq=1,
            step=0,
            created_at="t",
            status="running",
        ),
        events.TokenEvent(
            run_id="r1",
            seq=2,
            step=0,
            created_at="t",
            text="The sky ",
            channel="text",
        ),
        events.StepEndEvent(run_id="r1", seq=3, step=0, created_at="t"),
        events.TokenEvent(
            run_id="r1",
            seq=4,
            step=1,
            created_at="t",
            text="is blue [1].",
            channel="text",
        ),
        events.ToolOutputEvent(
            run_id="r1",
            seq=5,
            step=1,
            created_at="t",
            tool_call_id="t1",
            tool_name="webSearch",
            summary="1 result",
            results=[events.ToolCallResult(title="A", url="https://a", snippet="snip A")],
        ),
        events.StepErrorEvent(
            run_id="r1",
            seq=6,
            step=1,
            created_at="t",
            message="transient",
            will_retry=True,
        ),
        events.ToolOutputEvent(
            run_id="r1",
            seq=7,
            step=1,
            created_at="t",
            tool_call_id="t2",
            tool_name="webSearch",
            summary="0 results",
            results=None,  # empty web search -> no source
        ),
        events.ResultEvent(
            run_id="r1",
            seq=8,
            step=1,
            created_at="t",
            status="done",
            final_text="ignored",
        ),
    ]
    inputs = verify.aggregate_from_events(events_list)
    assert inputs.text == "The sky is blue [1]."
    assert len(inputs.sources) == 1
    assert inputs.sources[0].id == "1"
    assert inputs.sources[0].title == "A"


def test_aggregate_from_events_empty() -> None:
    """No tokens + no tool outputs -> empty inputs (verifier no-ops)."""
    events_list = [
        events.StatusEvent(
            run_id="r1",
            seq=1,
            step=0,
            created_at="t",
            status="running",
        ),
    ]
    inputs = verify.aggregate_from_events(events_list)
    assert inputs.text == ""
    assert inputs.sources == []
