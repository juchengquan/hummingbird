"""Recorded run streams for the frontend's AG-UI → store step
(`lib/client/runs/`, wave 4a of PLAN-frontend-backend-split).

The HTTP end-to-end tests (`test_runs_e2e.py`) record what the native
harness produces; this module records the stream mechanics it cannot
reach — reasoning, every part kind (`ACTIVITY_SNAPSHOT`), a compacted
log (`gap` + `MESSAGES_SNAPSHOT`), a purged one, a background rewind,
non-fatal step errors, sub-agent markers and a failed run — through the
real `AgUiRunEncoder` and `stream_run_events` over the memory log,
exactly what `GET /v1/runs/{id}/events` sends for such a log.

Every event is validated against the pinned AG-UI schema. With
`RUNS_E2E_FIXTURES_DIR` set, each stream's SSE body is written there as
`stream-<name>.sse` (next to the e2e tests' `<backend>-<name>.sse`).
Regenerate the committed copies with `bun run fixtures:runs`
(`scripts/record-runs-fixtures.sh`).
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from agent_py.events import (
    ArtifactRefEvent,
    CodeResultEvent,
    CompactEvent,
    McpAppEvent,
    PlanEvent,
    PlanItem,
    RoutedModelEvent,
    StepErrorEvent,
    SuggestionsEvent,
    TaskEvent,
    ToolCallResult,
    ToolFileEvent,
    ToolImageEvent,
    UiPartEvent,
    VerificationEvent,
)
from agent_py.runs.agui_encoder import AgUiRunEncoder
from agent_py.runs.compaction import compact_run
from agent_py.runs.event_log_memory import MemoryRunEventLog
from agent_py.runs.model import RunCursor, RunRecord
from agent_py.runs.stream import stream_run_events

from .runs_support import RUN_ID, Log, assert_valid, run_record

FIXTURES_DIR = os.environ.get("RUNS_E2E_FIXTURES_DIR", "")
R = RUN_ID


def _save(name: str, body: str) -> None:
    if FIXTURES_DIR:
        Path(FIXTURES_DIR).mkdir(parents=True, exist_ok=True)
        (Path(FIXTURES_DIR) / f"stream-{name}.sse").write_text(body)


async def _filled(entries: list[TaskEvent]) -> MemoryRunEventLog:
    log = MemoryRunEventLog(tick=0.02)
    for e in entries:
        await log.append(e)
    return log


async def _record(
    name: str,
    log: MemoryRunEventLog,
    holder: list[RunRecord | None],
    after: str | None = None,
) -> list[dict[str, object]]:
    record = holder[0]
    assert record is not None

    async def load() -> RunRecord | None:
        return holder[0]

    stream: AsyncIterator[str] = stream_run_events(
        run_id=R,
        after=None if after is None else RunCursor.parse(after),
        log=log,
        encoder=AgUiRunEncoder(record.id),
        load_run=load,
    )

    async def collect() -> list[str]:
        return [frame async for frame in stream]

    frames = await asyncio.wait_for(collect(), 5)
    body = "".join(frames)
    events: list[dict[str, object]] = []
    for frame in frames:
        data = next(line for line in frame.split("\n") if line.startswith("data: "))
        event = json.loads(data[6:])
        assert_valid(event)
        events.append(event)
    _save(name, body)
    return events


def _types(events: list[dict[str, object]]) -> list[object]:
    return [e["type"] for e in events]


def example_log() -> Log:
    """RUN_EVENTS.md § 9: reasoning, a searched tool call with results, an
    answer over two deltas."""
    log = Log()
    log.add(RoutedModelEvent, model="anthropic/claude-sonnet-4.6")
    log.step_start()
    log.think("Look it ")
    log.think("up.")
    log.tool("tc1", "webSearch", {"query": "sky colour"})
    log.output(
        "tc1",
        "webSearch",
        "1 result",
        [ToolCallResult(title="Sky", url="https://sky.example", snippet="It is blue.")],
    )
    log.step_end()
    log.step_start()
    log.text("It is ")
    log.text("blue.")
    log.step_end()
    log.result("done", final_text="It is blue.", memory_tainted=True)
    return log


async def test_reasoning_and_a_searched_answer() -> None:
    log = await _filled(example_log().entries)
    events = await _record("reasoning", log, [run_record(status="done")])
    assert "REASONING_MESSAGE_CONTENT" in _types(events)
    assert events[-1]["type"] == "RUN_FINISHED"


async def test_every_part_kind() -> None:
    b = Log()
    b.add(RoutedModelEvent, model="anthropic/claude-sonnet-4.6")
    b.step_start()
    b.add(
        PlanEvent,
        items=(
            PlanItem(id="p1", text="Draw", status="in_progress"),
            PlanItem(id="p2", text="Explain", status="pending"),
        ),
    )
    b.text("Here you go.")
    b.tool("img1", "generateImage", {"prompt": "a cat"})
    b.output("img1", "generateImage", "1 image")
    b.add(
        ToolImageEvent,
        tool_call_id="img1",
        mode="t2i",
        images=(
            {
                "id": "i1",
                "url": "data:image/png;base64,AAAA",
                "width": 64,
                "height": 64,
                "format": "png",
                "prompt": "a cat",
                "mode": "t2i",
            },
        ),
    )
    b.tool("code1", "runCode", {"code": "print(1)"})
    b.output("code1", "runCode", "Ran")
    b.add(
        CodeResultEvent,
        tool_call_id="code1",
        stdout="1\n",
        stderr="",
        results=({"type": "text", "value": "1"},),
    )
    b.add(
        ToolFileEvent,
        tool_call_id="code1",
        files=(
            {
                "id": "f1",
                "name": "out.csv",
                "sizeBytes": 4,
                "mimeType": "text/csv",
                "url": "https://files.example/out.csv",
            },
        ),
    )
    b.tool("ui1", "renderUI", {"kind": "info-table", "props": {"rows": []}})
    b.output("ui1", "renderUI", "Rendered")
    b.add(
        UiPartEvent,
        tool_call_id="ui1",
        ui_kind="info-table",
        props={"title": "Facts", "rows": [{"label": "Colour", "value": "Blue"}]},
    )
    b.tool("app1", "mcp__srv__show", {})
    b.output("app1", "mcp__srv__show", "Shown")
    b.add(
        McpAppEvent,
        tool_call_id="app1",
        server_id="srv",
        html="<p>app</p>",
        resource_uri="ui://srv/app",
    )
    b.add(ArtifactRefEvent, artifact_id="art-1")
    b.add(
        PlanEvent,
        items=(
            PlanItem(id="p1", text="Draw", status="completed"),
            PlanItem(id="p2", text="Explain", status="completed"),
        ),
    )
    b.step_end()
    b.add(
        VerificationEvent,
        verification={
            "checks": [{"claim": "It is blue.", "status": "supported", "sourceIds": ["s1"]}],
            "summary": {"supported": 1, "partial": 0, "unsupported": 0, "total": 1},
        },
    )
    b.add(SuggestionsEvent, values=("Why blue?", "Draw a dog"))
    b.result("done", final_text="Here you go.")
    log = await _filled(b.entries)
    events = await _record("parts", log, [run_record(status="done")])
    kinds = [e["activityType"] for e in events if e["type"] == "ACTIVITY_SNAPSHOT"]
    assert set(kinds) == {
        f"hummingbird.{k}"
        for k in (
            "routed_model",
            "plan",
            "tool_image",
            "code_result",
            "tool_file",
            "ui_part",
            "mcp_app",
            "artifact_ref",
            "verification",
            "suggestions",
        )
    }


async def test_compacted_log_gap_then_snapshot() -> None:
    log = await _filled(example_log().entries)
    assert await compact_run(log, R, mode="interactive") is True
    run = [run_record(status="done")]
    events = await _record("compacted", log, run)
    assert _types(events) == ["RUN_STARTED", "CUSTOM", "MESSAGES_SNAPSHOT", "RUN_FINISHED"]
    # A rejoin from a cursor the client got before compaction.
    events = await _record("compacted-after-4.1", log, run, after="4.1")
    assert events[1]["name"] == "hummingbird.gap"


async def test_purged_log() -> None:
    log = await _filled(example_log().entries)
    await log.purge(R)
    events = await _record("purged", log, [run_record(status="done")], after="7")
    assert _types(events) == ["RUN_STARTED", "CUSTOM", "MESSAGES_SNAPSHOT", "RUN_FINISHED"]


def _rewind_log() -> Log:
    b = Log()
    b.step_start()  # 1
    b.text("Checking. ")  # 2
    b.step_end()  # 3  ← checkpoint
    b.step_start()  # 4  dead attempt
    b.text("dead attempt")  # 5
    b.status("running", resumed_from_seq=3)  # 6
    b.step_start()  # 7
    b.text("Done.")  # 8
    b.step_end()  # 9
    b.result("done", final_text="Checking. Done.")  # 10
    return b


async def test_rewind_replay_and_live() -> None:
    b = _rewind_log()
    run = run_record(status="done", mode="background")
    replay = await _record("rewind-replay", await _filled(b.entries), [run])
    assert {"type": "CUSTOM", "name": "hummingbird.rewind", "value": {"after": 3}} in replay

    # Live: the dead attempt's events go out before the marker rewinds them.
    log = await _filled(b.entries[:5])
    holder: list[RunRecord | None] = [run_record(status="running", mode="background")]

    async def resume() -> None:
        await asyncio.sleep(0.05)
        for e in b.entries[5:]:
            await log.append(e)
        holder[0] = run

    task = asyncio.create_task(resume())
    live = await _record("rewind-live", log, holder)
    await task
    texts = [e["delta"] for e in live if e["type"] == "TEXT_MESSAGE_CONTENT"]
    assert texts == ["Checking. ", "dead attempt", "Done."]


async def test_step_error_subagent_and_failure() -> None:
    b = Log()
    b.step_start()
    b.text("Trying. ")
    b.add(StepErrorEvent, message="search timed out", will_retry=True)
    b.handoff("researcher", "enter", subgoal="dig deeper")
    b.handoff("researcher", "exit")
    b.add(CompactEvent, summary="earlier turns")
    b.tool("tc1", "webSearch", {"query": "x"})
    b.output("tc1", "webSearch", "Search failed: quota", is_error=True)
    b.step_end()
    b.result("failed", error="Rate limited by the provider.", error_code="rate_limit")
    log = await _filled(b.entries)
    events = await _record("failed", log, [run_record(status="failed")])
    assert events[-1] == {
        "type": "RUN_ERROR",
        "message": "Rate limited by the provider.",
        "code": "rate_limit",
    }


async def test_cancelled_mid_answer() -> None:
    b = Log()
    b.step_start()
    b.text("partial")
    b.status("cancelled")
    log = await _filled(b.entries)
    events = await _record("cancelled", log, [run_record(status="cancelled")])
    assert events[-1]["outcome"] == {"type": "cancelled"}


@pytest.mark.skipif(not FIXTURES_DIR, reason="RUNS_E2E_FIXTURES_DIR not set")
def test_fixtures_were_written() -> None:
    names = sorted(p.name for p in Path(FIXTURES_DIR).glob("stream-*.sse"))
    assert "stream-reasoning.sse" in names and "stream-parts.sse" in names
