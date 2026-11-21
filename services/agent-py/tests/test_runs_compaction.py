"""Compaction — RUN_EVENTS.md § 7 (the fold, T / C, idempotence)."""

from __future__ import annotations

from agent_py.events import (
    MessagesSnapshotEvent,
    PlanEvent,
    PlanItem,
    StepErrorEvent,
    SuggestionsEvent,
    ToolCallResult,
)
from agent_py.runs.compaction import (
    build_messages_snapshot,
    compact_run,
    first_closing_seq,
    fold_messages,
)
from agent_py.runs.event_log_memory import MemoryRunEventLog

from .runs_support import RUN_ID, Log, assert_valid

R = RUN_ID


def _example() -> Log:
    log = Log()
    log.add(SuggestionsEvent, values=("a",))  # 1, replaced below
    log.step_start()  # 2
    log.think("Look it up.")  # 3
    log.tool("tc1", "webSearch", {"query": "x"})  # 4
    log.output("tc1", "webSearch", "1 result", [ToolCallResult(title="t", url="u", snippet="s")])
    log.step_end()  # 6
    log.step_start()  # 7
    log.text("It is ")  # 8
    log.text("blue.")  # 9
    log.tool("tc2", "webFetch", {"url": "u"})  # 10 → on R:8
    log.output("tc2", "webFetch", "404", is_error=True)  # 11
    log.add(SuggestionsEvent, values=("b",))  # 12
    log.add(StepErrorEvent, message="hiccup")  # 13
    log.step_end()  # 14
    log.result("done", final_text="It is blue.")  # 15
    log.status("done")  # 16
    return log


def test_fold() -> None:
    entries = _example().entries
    assert first_closing_seq(entries) == 15
    messages = fold_messages(R, [e for e in entries if e.seq < 15])
    for m in messages:
        assert_valid(m, "Message")
    assert messages == [
        {
            "id": f"{R}:suggestions",
            "role": "activity",
            "activityType": "hummingbird.suggestions",
            "content": {"values": ["b"]},  # first position, last content
        },
        {"id": f"{R}:3", "role": "reasoning", "content": "Look it up."},
        {
            "id": f"{R}:4",
            "role": "assistant",
            "toolCalls": [
                {
                    "id": "tc1",
                    "type": "function",
                    "function": {"name": "webSearch", "arguments": '{"query":"x"}'},
                }
            ],
        },
        {
            "id": f"{R}:5",
            "role": "tool",
            "toolCallId": "tc1",
            "content": '{"summary":"1 result","results":[{"title":"t","url":"u","snippet":"s"}]}',
            "metadata": {"hummingbird": {"toolName": "webSearch"}},
        },
        {
            "id": f"{R}:8",
            "role": "assistant",
            "content": "It is blue.",
            "toolCalls": [
                {
                    "id": "tc2",
                    "type": "function",
                    "function": {"name": "webFetch", "arguments": '{"url":"u"}'},
                }
            ],
        },
        {
            "id": f"{R}:11",
            "role": "tool",
            "toolCallId": "tc2",
            "content": '{"summary":"404"}',
            "error": "404",
            "metadata": {"hummingbird": {"toolName": "webFetch"}},
        },
    ]


def test_snapshot_seq_is_the_highest_folded_entry() -> None:
    entries = _example().entries
    snap = build_messages_snapshot(R, entries)
    assert snap is not None
    assert (snap.seq, snap.step) == (14, 2)
    assert_valid({"type": "MESSAGES_SNAPSHOT", "messages": list(snap.messages)})


def test_nothing_to_fold() -> None:
    log = Log()
    log.result("failed", error="x")
    log.status("failed")
    assert build_messages_snapshot(R, log.entries) is None
    assert build_messages_snapshot(R, []) is None


def test_without_a_closing_entry_everything_is_folded() -> None:
    log = Log()
    log.step_start()
    log.text("cut off")
    assert first_closing_seq(log.entries) == 3
    snap = build_messages_snapshot(R, log.entries)
    assert snap is not None and snap.seq == 2
    assert snap.messages == ({"id": f"{R}:2", "role": "assistant", "content": "cut off"},)


def test_interrupted_run_keeps_its_closing_entries() -> None:
    log = Log()
    log.step_start()  # 1
    log.tool("tc", "deleteFile", {})  # 2
    log.approval("tc", "request", tool="deleteFile")  # 3
    log.status("paused")  # 4
    assert first_closing_seq(log.entries) == 4
    snap = build_messages_snapshot(R, log.entries)
    assert snap is not None and snap.seq == 3


def test_superseded_entries_are_not_folded() -> None:
    log = Log()
    log.step_start()  # 1
    log.text("dead")  # 2
    log.status("running", resumed_from_seq=0)  # 3
    log.step_start()  # 4
    log.text("alive")  # 5
    log.result("done")  # 6
    snap = build_messages_snapshot(R, log.entries)
    assert snap is not None and snap.seq == 5
    assert [m["id"] for m in snap.messages] == [f"{R}:5"]


def test_an_earlier_snapshot_is_kept_verbatim() -> None:
    log = Log()
    log.add(MessagesSnapshotEvent, messages=({"id": "old", "role": "assistant", "content": "x"},))
    log.add(PlanEvent, items=(PlanItem(id="1", text="a", status="pending"),))
    log.status("done")
    snap = build_messages_snapshot(R, log.entries)
    assert snap is not None
    assert [m["id"] for m in snap.messages] == ["old", f"{R}:plan"]
    # Only the snapshot below T: already compacted.
    assert build_messages_snapshot(R, [log.entries[0], log.entries[2]]) is None


async def test_compact_run_is_idempotent_and_interactive_only() -> None:
    log = MemoryRunEventLog()
    for e in _example().entries:
        await log.append(e)
    assert await compact_run(log, R, mode="background") is False
    assert len(await log.read(R)) == 16
    assert await compact_run(log, R, mode="interactive") is True
    kinds = [(e.seq, e.kind) for e in await log.read(R)]
    assert kinds == [(14, "messages_snapshot"), (15, "result"), (16, "status")]
    assert await compact_run(log, R, mode="interactive") is False
    assert await log.last_seq(R) == 16
