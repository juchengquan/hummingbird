"""Tests for the TaskEvent IR + wire serialisation.

The shape matters because rows from either producer (TS or Python)
flow through the same `task_events` table and the same projection
reducer in the frontend. Mistakes here surface as silent UI
regressions; the tests pin the payload keys.
"""

from __future__ import annotations

from agent_py.events import (
    HandoffEvent,
    ResultEvent,
    StatusEvent,
    StepEndEvent,
    StepStartEvent,
    TaskEvent,
    TokenEvent,
    event_to_row_payload,
    is_terminal_status,
)


def test_terminal_statuses() -> None:
    assert is_terminal_status("done") is True
    assert is_terminal_status("failed") is True
    assert is_terminal_status("cancelled") is True
    assert is_terminal_status("running") is False
    assert is_terminal_status("queued") is False
    assert is_terminal_status("paused") is False


def test_status_event_payload() -> None:
    e = StatusEvent(run_id="r", seq=1, step=0, created_at="t", status="running")
    assert e.kind == "status"
    assert event_to_row_payload(e) == {"status": "running"}


def test_token_event_payload_defaults_channel() -> None:
    e = TokenEvent(run_id="r", seq=2, step=1, created_at="t", text="hi")
    assert e.kind == "token"
    assert event_to_row_payload(e) == {"text": "hi", "channel": "text"}


def test_token_event_carries_explicit_channel() -> None:
    e = TokenEvent(run_id="r", seq=2, step=1, created_at="t", text="hi", channel="reasoning")
    assert event_to_row_payload(e) == {"text": "hi", "channel": "reasoning"}


def test_step_start_payload_is_empty() -> None:
    e = StepStartEvent(run_id="r", seq=1, step=1, created_at="t")
    assert event_to_row_payload(e) == {}


def test_step_end_payload_is_empty() -> None:
    e = StepEndEvent(run_id="r", seq=1, step=1, created_at="t")
    assert event_to_row_payload(e) == {}


def test_result_payload_done() -> None:
    e = ResultEvent(run_id="r", seq=9, step=2, created_at="t", status="done", final_text="ok")
    assert event_to_row_payload(e) == {"status": "done", "finalText": "ok"}


def test_result_payload_failed_with_error() -> None:
    e = ResultEvent(run_id="r", seq=9, step=2, created_at="t", status="failed", error="oops")
    assert event_to_row_payload(e) == {"status": "failed", "error": "oops"}


def test_result_payload_minimal() -> None:
    """`finalText` + `error` are both optional; omit absent ones to
    match the TS wire shape (no nulls)."""
    e = ResultEvent(run_id="r", seq=9, step=2, created_at="t", status="done")
    assert event_to_row_payload(e) == {"status": "done"}


def test_handoff_event_kind_and_fields() -> None:
    """HandoffEvent has kind=='handoff', agent, and phase."""
    e = HandoffEvent(run_id="r", seq=3, step=1, created_at="t", agent="researcher", phase="enter")
    assert e.kind == "handoff"
    assert e.agent == "researcher"
    assert e.phase == "enter"


def test_handoff_event_payload_includes_agent_and_phase() -> None:
    """event_to_row_payload serialises agent + phase for the DB row."""
    e = HandoffEvent(run_id="r", seq=3, step=1, created_at="t", agent="researcher", phase="enter")
    assert event_to_row_payload(e) == {"agent": "researcher", "phase": "enter"}


def test_handoff_event_exit_phase() -> None:
    e = HandoffEvent(run_id="r", seq=4, step=1, created_at="t", agent="summariser", phase="exit")
    assert event_to_row_payload(e) == {"agent": "summariser", "phase": "exit"}


def test_handoff_event_is_task_event_union_member() -> None:
    """HandoffEvent is a valid member of the TaskEvent union (runtime isinstance check)."""
    e: TaskEvent = HandoffEvent(
        run_id="r", seq=3, step=1, created_at="t", agent="researcher", phase="enter"
    )
    assert isinstance(e, HandoffEvent)
