"""The AG-UI encoder against RUN_EVENTS.md §§ 1 to 5, every event validated
against the pinned AG-UI 1.0 JSON Schema."""

from __future__ import annotations

from typing import Any, get_args

import pytest

from agent_py.events import (
    ArtifactRefEvent,
    CodeResultEvent,
    CompactEvent,
    InputRequestOption,
    McpAppEvent,
    MessagesSnapshotEvent,
    PlanEvent,
    PlanItem,
    RoutedModelEvent,
    StepErrorEvent,
    SuggestionsEvent,
    TaskEvent,
    TaskEventKind,
    ToolCallResult,
    ToolFileEvent,
    ToolImageEvent,
    UiPartEvent,
    VerificationEvent,
)
from agent_py.runs.agui_encoder import (
    AgUiRunEncoder,
    agui_encoder_factory,
    compact_json,
    gap_event,
)
from agent_py.runs.encoder import AgUiEncoder, AgUiEvent
from agent_py.runs.model import PendingInterrupt

from .runs_support import RUN_ID, THREAD_ID, USAGE, Log, assert_valid, run_record

R = RUN_ID


def _encode_all(entries: list[TaskEvent]) -> list[list[AgUiEvent]]:
    enc = AgUiRunEncoder(R)
    out = [enc.encode(e) for e in entries]
    for events in out:
        for ev in events:
            assert_valid(ev)
    return out


def _types(events: list[AgUiEvent]) -> list[object]:
    return [e["type"] for e in events]


def test_factory_builds_a_protocol_encoder() -> None:
    enc: AgUiEncoder = agui_encoder_factory(run_record())
    assert isinstance(enc, AgUiRunEncoder)


# --- § 9: the worked example, byte for byte ------------------------------------------


def test_worked_example_of_run_events_md() -> None:
    log = Log()
    log.add(RoutedModelEvent, model="m")
    log.step_start()
    log.think("Look it up.")
    log.tool("tc1", "webSearch", {"query": "x"})
    log.output("tc1", "webSearch", "1 result", [ToolCallResult(title="t", url="u", snippet="s")])
    log.step_end()
    log.step_start()
    log.text("It is ")
    log.text("blue.")
    log.step_end()
    log.result("done", final_text="It is blue.", memory_tainted=True)

    enc = AgUiRunEncoder(R)
    run = run_record()
    started = enc.start(run)
    assert started == [{"type": "RUN_STARTED", "threadId": THREAD_ID, "runId": R}]
    got = [enc.encode(e) for e in log.entries]
    for events in got:
        for ev in events:
            assert_valid(ev)

    assert got[0] == [
        {
            "type": "ACTIVITY_SNAPSHOT",
            "messageId": f"{R}:routed_model",
            "activityType": "hummingbird.routed_model",
            "content": {"model": "m"},
            "replace": True,
        }
    ]
    assert got[1] == [{"type": "STEP_STARTED", "stepName": "step-1"}]
    assert got[2] == [
        {"type": "REASONING_START", "messageId": f"{R}:3"},
        {"type": "REASONING_MESSAGE_START", "messageId": f"{R}:3", "role": "reasoning"},
        {"type": "REASONING_MESSAGE_CONTENT", "messageId": f"{R}:3", "delta": "Look it up."},
    ]
    assert got[3] == [
        {"type": "REASONING_MESSAGE_END", "messageId": f"{R}:3"},
        {"type": "REASONING_END", "messageId": f"{R}:3"},
        {
            "type": "TOOL_CALL_START",
            "toolCallId": "tc1",
            "toolCallName": "webSearch",
            "parentMessageId": f"{R}:4",
        },
        {"type": "TOOL_CALL_ARGS", "toolCallId": "tc1", "delta": '{"query":"x"}'},
        {"type": "TOOL_CALL_END", "toolCallId": "tc1"},
    ]
    assert got[4] == [
        {
            "type": "TOOL_CALL_RESULT",
            "messageId": f"{R}:5",
            "toolCallId": "tc1",
            "role": "tool",
            "content": '{"summary":"1 result","results":[{"title":"t","url":"u","snippet":"s"}]}',
            "metadata": {"hummingbird": {"toolName": "webSearch"}},
        }
    ]
    assert got[5] == [{"type": "STEP_FINISHED", "stepName": "step-1"}]
    assert got[6] == [{"type": "STEP_STARTED", "stepName": "step-2"}]
    assert got[7] == [
        {"type": "TEXT_MESSAGE_START", "messageId": f"{R}:8", "role": "assistant"},
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": f"{R}:8", "delta": "It is "},
    ]
    assert got[8] == [{"type": "TEXT_MESSAGE_CONTENT", "messageId": f"{R}:8", "delta": "blue."}]
    assert got[9] == [
        {"type": "TEXT_MESSAGE_END", "messageId": f"{R}:8"},
        {"type": "STEP_FINISHED", "stepName": "step-2"},
    ]
    assert got[10] == []
    closing = enc.finish(run_record(status="done"))
    assert closing == [
        {
            "type": "RUN_FINISHED",
            "threadId": THREAD_ID,
            "runId": R,
            "outcome": {"type": "success"},
            "result": {"text": "It is blue.", "memoryTainted": True},
        }
    ]
    assert_valid(closing[0])


# --- § 3.3 parts, table-driven -------------------------------------------------------

PARTS: list[tuple[type[Any], dict[str, Any], str, str, dict[str, object]]] = [
    (
        ToolImageEvent,
        {"tool_call_id": "c1", "mode": "t2i", "images": ({"id": "i", "url": "u"},)},
        f"{R}:tool_image:c1",
        "hummingbird.tool_image",
        {"id": "c1", "mode": "t2i", "images": [{"id": "i", "url": "u"}]},
    ),
    (
        ToolFileEvent,
        {"tool_call_id": "c2", "files": ({"id": "f", "name": "a.csv"},)},
        f"{R}:tool_file:c2",
        "hummingbird.tool_file",
        {"id": "c2", "files": [{"id": "f", "name": "a.csv"}]},
    ),
    (
        CodeResultEvent,
        {"tool_call_id": "c3", "stdout": "hi", "results": ({"type": "text", "value": "1"},)},
        f"{R}:code_result:c3",
        "hummingbird.code_result",
        {"id": "c3", "stdout": "hi", "stderr": "", "results": [{"type": "text", "value": "1"}]},
    ),
    (
        UiPartEvent,
        {"tool_call_id": "c4", "ui_kind": "table", "props": {"rows": []}},
        f"{R}:ui_part:c4",
        "hummingbird.ui_part",
        {"id": "c4", "kind": "table", "props": {"rows": []}},
    ),
    (
        UiPartEvent,
        {"tool_call_id": "c5", "ui_kind": "divider"},
        f"{R}:ui_part:c5",
        "hummingbird.ui_part",
        {"id": "c5", "kind": "divider"},
    ),
    (
        McpAppEvent,
        {
            "tool_call_id": "c6",
            "server_id": "s",
            "html": "<p/>",
            "resource_uri": "ui://x",
            "truncated": True,
        },
        f"{R}:mcp_app:c6",
        "hummingbird.mcp_app",
        {"id": "c6", "serverId": "s", "html": "<p/>", "resourceUri": "ui://x", "truncated": True},
    ),
    (
        McpAppEvent,
        {"tool_call_id": "c7", "server_id": "s", "html": "<p/>"},
        f"{R}:mcp_app:c7",
        "hummingbird.mcp_app",
        {"id": "c7", "serverId": "s", "html": "<p/>"},
    ),
    (
        VerificationEvent,
        {"verification": {"checks": [], "summary": {"n": 0}}},
        f"{R}:verification",
        "hummingbird.verification",
        {"checks": [], "summary": {"n": 0}},
    ),
    (
        SuggestionsEvent,
        {"values": ("Why?", "How?")},
        f"{R}:suggestions",
        "hummingbird.suggestions",
        {"values": ["Why?", "How?"]},
    ),
    (
        RoutedModelEvent,
        {"model": "anthropic/claude"},
        f"{R}:routed_model",
        "hummingbird.routed_model",
        {"model": "anthropic/claude"},
    ),
    (
        PlanEvent,
        {"items": (PlanItem(id="1", text="Search", status="in_progress"),)},
        f"{R}:plan",
        "hummingbird.plan",
        {"items": [{"id": "1", "text": "Search", "status": "in_progress"}]},
    ),
    (
        ArtifactRefEvent,
        {"artifact_id": "a1"},
        f"{R}:artifact:a1",
        "hummingbird.artifact_ref",
        {"artifactId": "a1"},
    ),
]


@pytest.mark.parametrize(
    ("cls", "fields", "message_id", "activity_type", "content"),
    PARTS,
    ids=[f"{p[0].__name__}-{i}" for i, p in enumerate(PARTS)],
)
def test_parts_become_activity_snapshots(
    cls: type[Any],
    fields: dict[str, Any],
    message_id: str,
    activity_type: str,
    content: dict[str, object],
) -> None:
    log = Log()
    log.text("hi")
    log.add(cls, **fields)
    got = _encode_all(log.entries)
    # The part closes the open text block first.
    assert got[1] == [
        {"type": "TEXT_MESSAGE_END", "messageId": f"{R}:1"},
        {
            "type": "ACTIVITY_SNAPSHOT",
            "messageId": message_id,
            "activityType": activity_type,
            "content": content,
            "replace": True,
        },
    ]


def test_background_result_verification_is_an_activity() -> None:
    log = Log()
    log.result("done", final_text="x", verification={"checks": [1], "summary": {}})
    (events,) = _encode_all(log.entries)
    assert events == [
        {
            "type": "ACTIVITY_SNAPSHOT",
            "messageId": f"{R}:verification",
            "activityType": "hummingbird.verification",
            "content": {"checks": [1], "summary": {}},
            "replace": True,
        }
    ]


# --- § 3.1 blocks ---------------------------------------------------------------------


def test_block_switching_and_empty_tokens() -> None:
    log = Log()
    log.think("a")  # 1
    log.text("")  # 2: nothing, closes nothing
    log.think("b")  # 3: same reasoning block
    log.text("c")  # 4: closes reasoning, opens text
    log.think("d")  # 5: closes text, opens reasoning
    log.status("running")  # 6: encodes to nothing but closes the block
    got = _encode_all(log.entries)
    assert _types(got[0]) == [
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
    ]
    assert got[1] == []
    assert got[2] == [{"type": "REASONING_MESSAGE_CONTENT", "messageId": f"{R}:1", "delta": "b"}]
    assert got[3] == [
        {"type": "REASONING_MESSAGE_END", "messageId": f"{R}:1"},
        {"type": "REASONING_END", "messageId": f"{R}:1"},
        {"type": "TEXT_MESSAGE_START", "messageId": f"{R}:4", "role": "assistant"},
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": f"{R}:4", "delta": "c"},
    ]
    assert _types(got[4]) == [
        "TEXT_MESSAGE_END",
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
    ]
    assert got[5] == [
        {"type": "REASONING_MESSAGE_END", "messageId": f"{R}:5"},
        {"type": "REASONING_END", "messageId": f"{R}:5"},
    ]


def test_tool_calls_attach_to_the_text_message_until_the_next_step() -> None:
    log = Log()
    log.step_start()  # 1
    log.text("Let me check.")  # 2
    log.tool("a", "webSearch", {"q": "ü", "n": 2})  # 3
    log.tool("b", "webFetch", {})  # 4
    log.step_end()  # 5
    log.step_start()  # 6
    log.tool("c", "webFetch", {"url": "x"})  # 7
    got = _encode_all(log.entries)
    assert got[2][1]["parentMessageId"] == f"{R}:2"
    # JSON(): compact, insertion order, non-ASCII not escaped.
    assert got[2][2] == {"type": "TOOL_CALL_ARGS", "toolCallId": "a", "delta": '{"q":"ü","n":2}'}
    assert got[3][0]["parentMessageId"] == f"{R}:2"
    assert got[6][0]["parentMessageId"] == f"{R}:7"


def test_tool_output_error_and_without_results() -> None:
    log = Log()
    log.output("a", "webFetch", "boom", is_error=True)
    log.output("b", "webFetch", "Fetched ✓")
    got = _encode_all(log.entries)
    assert got[0][0]["content"] == '{"summary":"boom"}'
    assert got[0][0]["metadata"] == {"hummingbird": {"toolName": "webFetch", "isError": True}}
    assert got[1][0]["content"] == '{"summary":"Fetched ✓"}'
    assert got[1][0]["metadata"] == {"hummingbird": {"toolName": "webFetch"}}


# --- § 3.2 / 3.4 everything else -------------------------------------------------------


def test_custom_events() -> None:
    log = Log()
    log.add(StepErrorEvent, message="timeout", will_retry=False)
    log.add(CompactEvent, summary="earlier turns")
    log.add(CompactEvent)
    log.approval("ap1", "response", approved=True)
    log.approval("ap2", "response", selection=["x"])
    log.approval("ap3", "response", value="v")
    log.approval("ap4", "response", ui_answer={"k": 1}, value="legacy")
    log.approval("ap5", "request", tool="t")
    got = _encode_all(log.entries)
    assert got[0] == [
        {
            "type": "CUSTOM",
            "name": "hummingbird.step_error",
            "value": {"message": "timeout", "willRetry": False},
        }
    ]
    assert got[1][0]["value"] == {"summary": "earlier turns"}
    assert got[2][0] == {"type": "CUSTOM", "name": "hummingbird.context_compacted", "value": {}}
    payloads = [g[0]["value"] for g in got[3:7]]
    assert payloads == [
        {"interruptId": "ap1", "payload": {"approved": True}},
        {"interruptId": "ap2", "payload": {"selection": ["x"]}},
        {"interruptId": "ap3", "payload": {"value": "v"}},
        {"interruptId": "ap4", "payload": {"uiAnswer": {"k": 1}}},
    ]
    # A request is announced as it is raised (and reported again by the
    # closing event): the same AG-UI `Interrupt` object.
    assert got[7] == [
        {
            "type": "CUSTOM",
            "name": "hummingbird.interrupt_pending",
            "value": {
                "id": "ap5",
                "reason": "approval",
                "responseSchema": {
                    "type": "object",
                    "required": ["approved"],
                    "properties": {"approved": {"type": "boolean"}, "args": {}},
                },
                "metadata": {"hummingbird": {"tool": "t"}},
            },
        }
    ]


def test_statuses_encode_to_nothing() -> None:
    log = Log()
    for status in ("queued", "running", "paused", "cancelled", "done", "failed"):
        log.status(status)
    assert all(events == [] for events in _encode_all(log.entries))


def test_resume_marker_rewinds_and_forgets_the_open_block() -> None:
    log = Log()
    log.step_start()  # 1
    log.text("partial")  # 2 — the dead attempt
    log.status("running", resumed_from_seq=1)  # 3
    log.text("again")  # 4
    log.status("running", restarted=True)  # 5: legacy marker
    got = _encode_all(log.entries)
    # No TEXT_MESSAGE_END at the marker: the client discards the start.
    assert got[2] == [{"type": "CUSTOM", "name": "hummingbird.rewind", "value": {"after": 1}}]
    assert got[3][0] == {"type": "TEXT_MESSAGE_START", "messageId": f"{R}:4", "role": "assistant"}
    assert got[4] == [{"type": "CUSTOM", "name": "hummingbird.rewind", "value": {"after": 1}}]


def test_subagents() -> None:
    log = Log()
    log.handoff("researcher", "enter", child_task_id="child-1", subgoal="dig")  # 1
    log.handoff("writer", "enter")  # 2
    log.handoff("writer", "enter")  # 3
    log.handoff("writer", "exit")  # 4 → most recent unmatched writer (3)
    log.handoff("researcher", "exit", child_task_id="child-1")  # 5
    log.handoff("ghost", "exit")  # 6 → matches nothing
    log.handoff("writer", "exit")  # 7 → 2
    got = _encode_all(log.entries)
    assert got[0] == [
        {
            "type": "SUBAGENT_STARTED",
            "subagentRunId": "child-1",
            "name": "researcher",
            "metadata": {"hummingbird": {"subgoal": "dig"}},
        }
    ]
    assert got[1] == [{"type": "SUBAGENT_STARTED", "subagentRunId": f"{R}:2", "name": "writer"}]
    assert got[3] == [{"type": "SUBAGENT_FINISHED", "subagentRunId": f"{R}:3"}]
    assert got[4] == [{"type": "SUBAGENT_FINISHED", "subagentRunId": "child-1"}]
    assert got[5] == []
    assert got[6] == [{"type": "SUBAGENT_FINISHED", "subagentRunId": f"{R}:2"}]


def test_messages_snapshot_and_gap() -> None:
    log = Log()
    log.add(
        MessagesSnapshotEvent,
        messages=({"id": f"{R}:1", "role": "assistant", "content": "hi"},),
    )
    (events,) = _encode_all(log.entries)
    assert events == [
        {
            "type": "MESSAGES_SNAPSHOT",
            "messages": [{"id": f"{R}:1", "role": "assistant", "content": "hi"}],
        }
    ]
    for gap in (
        gap_event(after="0", resume_at=10, reason="compacted"),
        gap_event(after="3.1", resume_at=None, reason="purged"),
    ):
        assert_valid(gap)


def test_compact_json_matches_json_stringify() -> None:
    assert compact_json({"b": 1, "a": [1, "é"], "c": None}) == '{"b":1,"a":[1,"é"],"c":null}'


# --- §§ 1, 4, 5: start and the closing events -----------------------------------------


def test_start_carries_the_parent_run() -> None:
    enc = AgUiRunEncoder(R)
    (started,) = enc.start(run_record(parent_run_id="p1"))
    assert started == {
        "type": "RUN_STARTED",
        "threadId": THREAD_ID,
        "runId": R,
        "parentRunId": "p1",
    }
    assert_valid(started)


INTERRUPT = PendingInterrupt(
    id="tc9",
    request_kind="choice",
    tool="askUser",
    tool_call_id="tc9",
    prompt="Which?",
    options=(InputRequestOption(id="a", label="A"),),
    multi=False,
).to_agui()


CLOSINGS: list[tuple[str, dict[str, Any], list[TaskEvent], AgUiEvent]] = [
    (
        "succeeded from the row",
        {"status": "done", "result": {"text": "row", "extra": 1}},
        [],
        {
            "type": "RUN_FINISHED",
            "threadId": THREAD_ID,
            "runId": R,
            "outcome": {"type": "success"},
            "result": {"text": "row", "extra": 1},
        },
    ),
    (
        "succeeded, pre-0041 row: result from the log, usage",
        {"status": "done"},
        [Log().result("done", final_text="log", usage=USAGE)],
        {
            "type": "RUN_FINISHED",
            "threadId": THREAD_ID,
            "runId": R,
            "outcome": {"type": "success"},
            "result": {"text": "log"},
            "usage": [
                {
                    "provider": "anthropic",
                    "model": "claude-x",
                    "inputTokens": 10,
                    "outputTokens": 5,
                    "totalTokens": 15,
                }
            ],
        },
    ),
    (
        "succeeded with nothing",
        {"status": "done"},
        [],
        {
            "type": "RUN_FINISHED",
            "threadId": THREAD_ID,
            "runId": R,
            "outcome": {"type": "success"},
            "result": {},
        },
    ),
    (
        "failed from the row",
        {"status": "failed", "error": {"code": "rate_limit", "message": "Slow down."}},
        [],
        {"type": "RUN_ERROR", "message": "Slow down.", "code": "rate_limit"},
    ),
    (
        "failed, pre-0041: from the result entry",
        {"status": "failed"},
        [Log().result("failed", error="Boom", error_code="provider")],
        {"type": "RUN_ERROR", "message": "Boom", "code": "provider"},
    ),
    (
        "failed, result entry without code",
        {"status": "failed"},
        [Log().result("failed")],
        {"type": "RUN_ERROR", "message": "Run failed.", "code": "unknown"},
    ),
    (
        "failed by the interactive reaper",
        {"status": "failed"},
        [],
        {"type": "RUN_ERROR", "message": "Run failed.", "code": "worker_lost"},
    ),
    (
        "failed by the stale-run reconciler",
        {"status": "failed", "mode": "background"},
        [],
        {"type": "RUN_ERROR", "message": "Run failed.", "code": "no_worker"},
    ),
    (
        "cancelled",
        {"status": "cancelled"},
        [],
        {
            "type": "RUN_FINISHED",
            "threadId": THREAD_ID,
            "runId": R,
            "outcome": {"type": "cancelled"},
        },
    ),
    (
        "interrupted",
        {"status": "paused", "open_interrupts": (INTERRUPT,)},
        [],
        {
            "type": "RUN_FINISHED",
            "threadId": THREAD_ID,
            "runId": R,
            "outcome": {"type": "interrupt", "interrupts": [INTERRUPT]},
        },
    ),
]


@pytest.mark.parametrize(
    ("row", "entries", "expected"),
    [c[1:] for c in CLOSINGS],
    ids=[c[0] for c in CLOSINGS],
)
def test_closing_events(row: dict[str, Any], entries: list[TaskEvent], expected: AgUiEvent) -> None:
    enc = AgUiRunEncoder(R)
    for entry in entries:
        enc.encode(entry)
    closing = enc.finish(run_record(**row))
    assert closing == [expected]
    assert_valid(closing[0])


def test_finish_closes_an_open_block_and_spends_the_encoder() -> None:
    enc = AgUiRunEncoder(R)
    log = Log()
    enc.encode(log.text("dangling"))
    closing = enc.finish(run_record(status="cancelled"))
    assert _types(closing) == ["TEXT_MESSAGE_END", "RUN_FINISHED"]
    with pytest.raises(RuntimeError):
        enc.encode(log.text("more"))


@pytest.mark.parametrize("status", ["cancelled", "failed", "done"])
def test_finish_closes_an_open_step_and_subagents(status: str) -> None:
    """A cancel settles the row before the harness writes its `step_end`,
    so a stream can end mid-step: the closing event must not land inside
    the step (or a sub-agent) — AG-UI forbids RUN_FINISHED there."""
    enc = AgUiRunEncoder(R)
    log = Log()
    for entry in (
        log.step_start(),
        log.handoff("researcher", "enter", child_task_id="child-1"),
        log.handoff("writer", "enter"),
        log.text("dangling"),
    ):
        enc.encode(entry)
    closing = enc.finish(run_record(status=status))
    assert closing[:4] == [
        {"type": "TEXT_MESSAGE_END", "messageId": f"{R}:4"},
        {"type": "SUBAGENT_FINISHED", "subagentRunId": f"{R}:3"},
        {"type": "SUBAGENT_FINISHED", "subagentRunId": "child-1"},
        {"type": "STEP_FINISHED", "stepName": "step-1"},
    ]
    assert closing[4]["type"] == ("RUN_ERROR" if status == "failed" else "RUN_FINISHED")
    for event in closing:
        assert_valid(event)


def test_finish_leaves_closed_steps_and_rewound_ones_alone() -> None:
    enc = AgUiRunEncoder(R)
    log = Log()
    for entry in (log.step_start(), log.step_end()):
        enc.encode(entry)
    assert _types(enc.finish(run_record(status="done"))) == ["RUN_FINISHED"]
    # A step the dead attempt opened is discarded by the rewind, not closed.
    enc = AgUiRunEncoder(R)
    log = Log()
    for entry in (
        log.step_start(),  # 1
        log.step_end(),  # 2  ← checkpoint
        log.step_start(),  # 3  dead attempt
        log.status("running", resumed_from_seq=2),  # 4
    ):
        enc.encode(entry)
    assert _types(enc.finish(run_record(status="cancelled"))) == ["RUN_FINISHED"]


@pytest.mark.parametrize("status", ["queued", "running"])
def test_finish_refuses_a_live_run(status: str) -> None:
    with pytest.raises(ValueError):
        AgUiRunEncoder(R).finish(run_record(status=status))
    # paused without interrupts: a parent waiting on its sub-agents.
    with pytest.raises(ValueError):
        AgUiRunEncoder(R).finish(run_record(status="paused"))


def test_a_rewind_forgets_a_superseded_result() -> None:
    enc = AgUiRunEncoder(R)
    log = Log()
    enc.encode(log.status("running"))  # 1
    enc.encode(log.result("done", final_text="dead", usage=USAGE))  # 2
    enc.encode(log.status("running", resumed_from_seq=1))  # 3
    (closing,) = enc.finish(run_record(status="done"))
    assert closing["result"] == {}
    assert "usage" not in closing


def _one_of_every_kind() -> list[TaskEvent]:
    log = Log()
    log.status("running")
    log.step_start()
    log.think("t")
    log.text("x")
    log.tool("c", "webSearch", {"q": "x"})
    log.output("c", "webSearch", "1 result")
    log.add(StepErrorEvent, message="m")
    log.handoff("a", "enter")
    log.handoff("a", "exit")
    log.approval("p", "request", tool="t")
    log.approval("p", "response", approved=False)
    log.add(CompactEvent)
    for cls, fields, *_ in PARTS:
        log.add(cls, **fields)
    log.add(MessagesSnapshotEvent, messages=())
    log.step_end()
    log.result("done", final_text="x", usage=USAGE)
    return log.entries


def test_every_internal_kind_encodes_to_valid_agui() -> None:
    entries = _one_of_every_kind()
    assert {e.kind for e in entries} == set(get_args(TaskEventKind))
    _encode_all(entries)  # validates every event
