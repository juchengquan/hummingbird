"""The run-model event kinds (wave 3a of PLAN-frontend-backend-split).

Pins two things 3b builds on:
  * every `TaskEventKind` has a dataclass in the `TaskEvent` union, and
  * every event survives `event_to_row_payload` → `event_from_row_payload`
    unchanged — the Postgres run event log (3b-A) is exactly that pair.
"""

from __future__ import annotations

import typing

import pytest

from agent_py import events
from agent_py.store import event_from_row_payload

_B = {"run_id": "", "seq": 7, "step": 2, "created_at": "2026-11-21T00:00:00Z"}

ONE_OF_EACH: list[events.TaskEvent] = [
    events.StatusEvent(**_B, status="running", resumed_from_seq=3, restarted=True),
    events.StepStartEvent(**_B),
    events.StepEndEvent(**_B),
    events.TokenEvent(**_B, text="hi", channel="reasoning"),
    events.ResultEvent(
        **_B,
        status="failed",
        final_text="partial",
        error="Rate limited.",
        error_code="rate_limit",
        memory_tainted=True,
        usage=(
            events.TokenUsage(
                provider="anthropic",
                model="claude-sonnet-4-6",
                input_tokens=10,
                output_tokens=5,
                cached_input_tokens=4,
            ),
        ),
        verification={"checks": [], "summary": {"total": 0}},
    ),
    events.ToolInputEvent(**_B, tool_call_id="tc1", tool_name="webSearch", args={"query": "x"}),
    events.ToolOutputEvent(
        **_B,
        tool_call_id="tc1",
        tool_name="webSearch",
        summary="boom",
        results=[events.ToolCallResult(title="t", url="https://e.x", snippet="s")],
        is_error=True,
    ),
    events.StepErrorEvent(**_B, message="retrying", will_retry=False),
    events.HandoffEvent(**_B, agent="researcher", phase="enter", child_task_id="c1", subgoal="g"),
    events.ApprovalEvent(
        **_B,
        approval_id="tc9",
        phase="request",
        request_kind="ui-part",
        tool="renderUI",
        tool_call_id="tc9",
        args={"kind": "confirm"},
        ui_kind="confirm",
        ui_props={"title": "Sure?"},
    ),
    events.ApprovalEvent(
        **_B,
        approval_id="tc8",
        phase="request",
        request_kind="choice",
        tool="askUser",
        tool_call_id="tc8",
        prompt="Which?",
        options=[events.InputRequestOption(id="a", label="A")],
        multi=False,
    ),
    events.ApprovalEvent(
        **_B,
        approval_id="tc8",
        phase="response",
        request_kind="choice",
        selection=["a"],
    ),
    events.PlanEvent(
        **_B,
        items=(
            events.PlanItem(id="1", text="search", status="completed"),
            events.PlanItem(id="2", text="write", status="in_progress"),
        ),
    ),
    events.CompactEvent(**_B, summary="earlier turns, summarised"),
    events.ArtifactRefEvent(**_B, artifact_id="a1"),
    events.ToolImageEvent(
        **_B,
        tool_call_id="tc2",
        mode="code",
        images=({"id": "i1", "url": "https://img", "width": 1, "height": 1},),
    ),
    events.ToolFileEvent(**_B, tool_call_id="tc3", files=({"id": "f1", "name": "a.csv"},)),
    events.CodeResultEvent(
        **_B,
        tool_call_id="tc3",
        stdout="ok\n",
        stderr="",
        results=({"type": "text", "value": "42"},),
    ),
    events.UiPartEvent(**_B, tool_call_id="tc4", ui_kind="info-table", props={"rows": []}),
    events.McpAppEvent(
        **_B,
        tool_call_id="tc5",
        server_id="srv",
        html="<p>hi</p>",
        resource_uri="ui://x",
        truncated=True,
    ),
    events.VerificationEvent(**_B, verification={"checks": [{"id": "c"}], "summary": {}}),
    events.SuggestionsEvent(**_B, values=("Tell me more", "Why?")),
    events.RoutedModelEvent(**_B, model="anthropic/claude-haiku-4.5"),
    events.MessagesSnapshotEvent(
        **_B, messages=({"id": "m1", "role": "assistant", "content": "hello"},)
    ),
]


def test_every_kind_has_exactly_one_event_class() -> None:
    kinds = set(typing.get_args(events.TaskEventKind))
    classes = typing.get_args(events.TaskEvent)
    by_kind = {c.__dataclass_fields__["kind"].default for c in classes}
    assert by_kind == kinds
    assert len(classes) == len(kinds)
    assert {e.kind for e in ONE_OF_EACH} == kinds


@pytest.mark.parametrize("event", ONE_OF_EACH, ids=lambda e: e.kind)
def test_row_payload_round_trips(event: events.TaskEvent) -> None:
    payload = events.event_to_row_payload(event)
    back = event_from_row_payload(
        seq=event.seq,
        step=event.step,
        kind=event.kind,
        created_at=event.created_at,
        payload=payload,
    )
    assert back == event


def test_new_fields_are_omitted_when_unset() -> None:
    """Background rows the TS projection reads keep their old payloads."""
    result = events.ResultEvent(**_B, status="done", final_text="x")
    assert events.event_to_row_payload(result) == {"status": "done", "finalText": "x"}
    out = events.ToolOutputEvent(**_B, tool_call_id="t", tool_name="n", summary="s")
    assert "isError" not in events.event_to_row_payload(out)


def test_token_usage_payload_is_an_agui_token_usage() -> None:
    usage = events.TokenUsage(provider="p", model="m", input_tokens=3, output_tokens=4)
    assert usage.to_payload() == {
        "provider": "p",
        "model": "m",
        "inputTokens": 3,
        "outputTokens": 4,
        "totalTokens": 7,
    }
    assert events.TokenUsage.from_payload(usage.to_payload()) == usage
    assert events.TokenUsage.from_payload("nope") is None


def test_part_kinds_are_event_kinds() -> None:
    assert set(typing.get_args(events.TaskEventKind)) >= events.PART_EVENT_KINDS
