"""stream_run_events — RUN_EVENTS.md § 6 over the memory log and the real
encoder."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import replace

import pytest

from agent_py.events import RoutedModelEvent, TaskEvent, ToolCallResult
from agent_py.runs.agui_encoder import AgUiRunEncoder
from agent_py.runs.compaction import compact_run
from agent_py.runs.encoder import RecordingEncoder
from agent_py.runs.event_log_memory import MemoryRunEventLog
from agent_py.runs.model import RunCursor, RunRecord
from agent_py.runs.stream import CursorOutOfRange, sse_frame, stream_run_events

from .runs_support import RUN_ID, THREAD_ID, Log, assert_valid, run_record

R = RUN_ID


def example_log() -> Log:
    """RUN_EVENTS.md § 9."""
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
    return log


async def _filled(entries: list[TaskEvent]) -> MemoryRunEventLog:
    log = MemoryRunEventLog(tick=0.02)
    for e in entries:
        await log.append(e)
    return log


def _loader(holder: list[RunRecord | None]) -> Callable[[], Awaitable[RunRecord | None]]:
    async def load() -> RunRecord | None:
        return holder[0]

    return load


async def _collect(stream: AsyncIterator[str], timeout: float = 3.0) -> list[str]:
    async def go() -> list[str]:
        return [frame async for frame in stream]

    return await asyncio.wait_for(go(), timeout)


def _parse(frame: str) -> tuple[str | None, dict[str, object]]:
    assert frame.endswith("\n\n")
    lines = frame[:-2].split("\n")
    sse_id = None
    if lines[0].startswith("id: "):
        sse_id = lines.pop(0)[4:]
    assert len(lines) == 1 and lines[0].startswith("data: ")
    event = json.loads(lines[0][6:])
    assert_valid(event)
    return sse_id, event


def _stream(
    log: MemoryRunEventLog, run: RunRecord | list[RunRecord | None], after: str | None = None
) -> AsyncIterator[str]:
    holder = run if isinstance(run, list) else [run]
    record = holder[0]
    assert record is not None
    return stream_run_events(
        run_id=R,
        after=None if after is None else RunCursor.parse(after),
        log=log,
        encoder=AgUiRunEncoder(record.id),
        load_run=_loader(holder),
    )


def test_sse_frame() -> None:
    assert sse_frame({"type": "X", "a": "é"}) == 'data: {"type":"X","a":"é"}\n\n'
    assert sse_frame({"type": "X"}, RunCursor(3, 1)) == 'id: 3.1\ndata: {"type":"X"}\n\n'


async def test_full_replay_of_a_finished_run() -> None:
    log = await _filled(example_log().entries)
    frames = await _collect(_stream(log, run_record(status="done")))
    parsed = [_parse(f) for f in frames]
    ids = [i for i, _ in parsed]
    assert ids == [
        None,  # RUN_STARTED
        "1",
        "2",
        "3.0",
        "3.1",
        "3",
        "4.0",
        "4.1",
        "4.2",
        "4.3",
        "4",
        "5",
        "6",
        "7",
        "8.0",
        "8",
        "9",
        "10.0",
        "10",
        None,  # RUN_FINISHED
    ]
    assert parsed[0][1] == {"type": "RUN_STARTED", "threadId": THREAD_ID, "runId": R}
    assert parsed[-1][1]["type"] == "RUN_FINISHED"
    assert parsed[-1][1]["result"] == {"text": "It is blue.", "memoryTainted": True}


async def test_every_cursor_resumes_byte_identically() -> None:
    log = await _filled(example_log().entries)
    run = run_record(status="done")
    full = await _collect(_stream(log, run))
    body = full[1:-1]
    for i, frame in enumerate(body):
        cursor = _parse(frame)[0]
        assert cursor is not None
        resumed = await _collect(_stream(log, run, after=cursor))
        assert resumed[0] == full[0]
        assert resumed[1:] == [*body[i + 1 :], full[-1]], f"after={cursor}"
    # The documented example: after 4.1 → RUN_STARTED, then TOOL_CALL_START (4.2).
    resumed = await _collect(_stream(log, run, after="4.1"))
    assert _parse(resumed[1])[0] == "4.2"
    assert _parse(resumed[1])[1]["type"] == "TOOL_CALL_START"


async def test_cursor_validation() -> None:
    log = await _filled(example_log().entries)
    with pytest.raises(CursorOutOfRange):
        await _collect(_stream(log, run_record(status="done"), after="12"))
    missing = stream_run_events(
        run_id=R, after=None, log=log, encoder=AgUiRunEncoder(R), load_run=_loader([None])
    )
    with pytest.raises(LookupError):
        await missing.__anext__()


async def test_a_compacted_log_answers_with_a_gap_and_a_snapshot() -> None:
    entries = example_log().entries
    log = await _filled(entries)
    assert await compact_run(log, R, mode="interactive") is True
    run = run_record(status="done")
    for after in (None, "0", "4.1", "9", "10.0"):
        frames = [_parse(f) for f in await _collect(_stream(log, run, after=after))]
        assert [f[1]["type"] for f in frames] == [
            "RUN_STARTED",
            "CUSTOM",
            "MESSAGES_SNAPSHOT",
            "RUN_FINISHED",
        ], after
        assert frames[1] == (
            None,
            {
                "type": "CUSTOM",
                "name": "hummingbird.gap",
                "value": {"after": after or "0", "resumeAt": 10, "reason": "compacted"},
            },
        )
        assert frames[2][0] == "10"
        messages = frames[2][1]["messages"]
        assert isinstance(messages, list)
        assert [(m["id"], m["role"]) for m in messages] == [
            (f"{R}:routed_model", "activity"),
            (f"{R}:3", "reasoning"),
            (f"{R}:4", "assistant"),
            (f"{R}:5", "tool"),
            (f"{R}:8", "assistant"),
        ]
    # At or past the snapshot: no gap.
    frames = [_parse(f) for f in await _collect(_stream(log, run, after="10"))]
    assert [f[1]["type"] for f in frames] == ["RUN_STARTED", "RUN_FINISHED"]


async def test_a_purged_log() -> None:
    log = await _filled(example_log().entries)
    await log.purge(R)
    frames = [_parse(f) for f in await _collect(_stream(log, run_record(status="done"), after="7"))]
    assert frames == [
        (None, {"type": "RUN_STARTED", "threadId": THREAD_ID, "runId": R}),
        (
            None,
            {
                "type": "CUSTOM",
                "name": "hummingbird.gap",
                "value": {"after": "7", "resumeAt": None, "reason": "purged"},
            },
        ),
        (None, {"type": "MESSAGES_SNAPSHOT", "messages": []}),
        (
            None,
            {
                "type": "RUN_FINISHED",
                "threadId": THREAD_ID,
                "runId": R,
                "outcome": {"type": "success"},
                "result": {},
            },
        ),
    ]


async def test_an_empty_log_of_a_live_run_is_not_purged() -> None:
    log = MemoryRunEventLog(tick=0.02)
    holder: list[RunRecord | None] = [run_record(status="queued", mode="background")]
    with pytest.raises(CursorOutOfRange):
        await _stream(log, holder, after="1").__anext__()
    stream = _stream(log, holder)
    first = await stream.__anext__()
    assert _parse(first)[1]["type"] == "RUN_STARTED"
    holder[0] = None  # the run was deleted: the stream just ends
    assert await _collect(stream) == []


async def test_live_tail_in_process_ends_on_seal_and_row() -> None:
    entries = example_log().entries
    log = MemoryRunEventLog(tick=0.02)
    holder: list[RunRecord | None] = [run_record(status="running")]

    async def drive() -> None:
        for e in entries:
            await log.append(e)
            await asyncio.sleep(0.005)
        holder[0] = run_record(status="done")
        await log.seal(R)

    driver = asyncio.create_task(drive())
    live = await _collect(_stream(log, holder))
    await driver
    replay = await _collect(_stream(log, run_record(status="done")))
    assert live == replay


async def test_live_tail_without_a_seal_ends_on_the_row() -> None:
    """A reader in another process never sees the seal: it stops on the row."""
    entries = example_log().entries
    log = MemoryRunEventLog(tick=0.02)
    holder: list[RunRecord | None] = [run_record(status="running")]
    for e in entries[:5]:
        await log.append(e)

    async def drive() -> None:
        await asyncio.sleep(0.05)
        for e in entries[5:]:
            await log.append(e)
        holder[0] = run_record(status="done")

    driver = asyncio.create_task(drive())
    live = await _collect(_stream(log, holder, after="3.1"))
    await driver
    replay = await _collect(_stream(log, run_record(status="done"), after="3.1"))
    assert live == replay


async def test_paused_waiting_on_children_keeps_tailing() -> None:
    b = Log()
    b.step_start()
    b.status("paused")
    log = await _filled(b.entries)
    holder: list[RunRecord | None] = [run_record(status="paused", mode="background")]

    async def resume() -> None:
        await asyncio.sleep(0.1)
        await log.append(b.status("running"))
        await log.append(b.text("done now"))
        await log.append(b.result("done", final_text="done now"))
        holder[0] = run_record(status="done", mode="background")

    task = asyncio.create_task(resume())
    frames = [_parse(f)[1] for f in await _collect(_stream(log, holder))]
    await task
    assert [f["type"] for f in frames] == [
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",  # the log never ended step 1; the closing events do
        "RUN_FINISHED",
    ]


async def test_pre_0041_paused_row_reads_open_interrupts_from_the_log() -> None:
    b = Log()
    b.step_start()
    b.tool("tc1", "deleteFile", {"path": "a"})
    b.approval("tc1", "request", tool="deleteFile", tool_call_id="tc1", args={"path": "a"})
    b.approval("old", "request", tool="x")
    b.approval("old", "response", approved=True)
    b.status("paused")
    log = await _filled(b.entries)
    row = run_record(status="paused", mode="background")  # no outcome
    frames = [_parse(f)[1] for f in await _collect(_stream(log, row))]
    closing = frames[-1]
    assert closing["outcome"] == {
        "type": "interrupt",
        "interrupts": [
            {
                "id": "tc1",
                "reason": "approval",
                "responseSchema": {
                    "type": "object",
                    "required": ["approved"],
                    "properties": {"approved": {"type": "boolean"}, "args": {}},
                },
                "toolCallId": "tc1",
                "metadata": {"hummingbird": {"tool": "deleteFile", "args": {"path": "a"}}},
            }
        ],
    }


async def test_replay_drops_superseded_entries_but_keeps_the_rewind() -> None:
    b = Log()
    b.step_start()  # 1
    b.text("a")  # 2
    b.step_end()  # 3  ← checkpoint
    b.step_start()  # 4  dead attempt
    b.text("dead")  # 5
    b.status("running", resumed_from_seq=3)  # 6
    b.step_start()  # 7
    b.text("b")  # 8
    b.step_end()  # 9
    b.result("done", final_text="ab")  # 10
    log = await _filled(b.entries)
    run = run_record(status="done", mode="background")
    frames = [_parse(f) for f in await _collect(_stream(log, run))]
    ids = [i for i, _ in frames]
    assert "4" not in ids and "5" not in ids and "5.0" not in ids
    assert ("6", {"type": "CUSTOM", "name": "hummingbird.rewind", "value": {"after": 3}}) in frames
    # Resuming from inside the superseded range still lands on the marker.
    resumed = [_parse(f) for f in await _collect(_stream(log, run, after="5.0"))]
    assert resumed[1][0] == "6"


async def test_live_rewind_after_a_dead_attempt() -> None:
    """Live, the dead attempt's events go out, then the marker rewinds."""
    b = Log()
    b.step_start()  # 1
    b.text("dead")  # 2
    log = await _filled(b.entries)
    holder: list[RunRecord | None] = [run_record(status="running", mode="background")]

    async def resume() -> None:
        await asyncio.sleep(0.05)
        await log.append(b.status("running", resumed_from_seq=0))  # 3
        await log.append(b.step_start())  # 4
        await log.append(b.result("done"))  # 5
        holder[0] = run_record(status="done", mode="background")

    task = asyncio.create_task(resume())
    frames = [_parse(f) for f in await _collect(_stream(log, holder))]
    await task
    assert [(i, f["type"]) for i, f in frames] == [
        (None, "RUN_STARTED"),
        ("1", "STEP_STARTED"),
        ("2.0", "TEXT_MESSAGE_START"),
        ("2", "TEXT_MESSAGE_CONTENT"),
        ("3", "CUSTOM"),  # rewind, no TEXT_MESSAGE_END for the discarded block
        ("4", "STEP_STARTED"),
        (None, "STEP_FINISHED"),  # step 4 never ended in the log
        (None, "RUN_FINISHED"),
    ]


async def test_works_with_any_encoder() -> None:
    log = await _filled(example_log().entries[:3])
    run = run_record(status="cancelled")
    frames = await _collect(
        stream_run_events(
            run_id=R, after=None, log=log, encoder=RecordingEncoder(run), load_run=_loader([run])
        )
    )
    assert [json.loads(f.split("data: ")[1])["type"] for f in frames] == [
        "RUN_STARTED",
        "CUSTOM",
        "CUSTOM",
        "CUSTOM",
        "RUN_FINISHED",
    ]


async def test_client_disconnect_releases_the_subscription() -> None:
    log = await _filled(example_log().entries[:2])
    holder: list[RunRecord | None] = [run_record(status="running")]
    stream = _stream(log, holder)
    got = [await stream.__anext__() for _ in range(3)]
    assert len(got) == 3
    waiter = asyncio.create_task(stream.__anext__())
    await asyncio.sleep(0.05)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    await stream.aclose()  # type: ignore[attr-defined]


def test_effective_run_is_identity_for_rows_with_an_outcome() -> None:
    from agent_py.runs.stream import OpenApprovals, effective_run

    row = run_record(status="done")
    assert effective_run(row, OpenApprovals()) is row
    waiting = run_record(status="paused", mode="background")
    assert effective_run(waiting, OpenApprovals()) is waiting
    assert replace(waiting).status == "running"
