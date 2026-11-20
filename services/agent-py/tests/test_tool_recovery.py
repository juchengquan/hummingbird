"""Reclaimed runs never silently re-run a side-effecting tool, and never
step past an unanswered approval-gated call.

  1. A side-effecting tool is bracketed by an execution record in the
     checkpoint (`tool_ledger`); read-only tools write nothing.
  2. A reclaimed run whose checkpoint records a side-effecting tool as
     started-but-unfinished does NOT re-run it: the model gets an
     "interrupted, outcome unknown" result. Recorded results are reused;
     read-only (and never-started) calls run again.
  3. A reclaimed `respond` whose dead attempt started the approved tool
     does not run it again.
  4. A reclaimed run whose checkpoint is suspended on an unanswered gated
     call pauses again (request + `status: paused` + row `paused`).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import executor, store, tool_ledger
from agent_py.events import (
    ApprovalEvent,
    ResultEvent,
    StatusEvent,
    StepEndEvent,
    StepErrorEvent,
    StepStartEvent,
    TaskEvent,
    ToolInputEvent,
    ToolOutputEvent,
)
from agent_py.executor import StartActionPayload
from agent_py.providers.anthropic_provider import AnthropicStepConfig, make_anthropic_step_fn
from agent_py.runner import RunStepContext, RunStepFn, RunStepOutcome
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

from .test_anthropic_provider import _FakeClient
from .test_job_lease import RUN_ID, USER_ID

# --- helpers ----------------------------------------------------------------


class _Crash(BaseException):
    """Stands in for the worker process dying mid-tool: nothing in the
    run catches it, so no write follows."""


def _list_sink() -> tuple[list[TaskEvent], Any]:
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    return collected, sink


def _tool(
    name: str, calls: list[str], *, side_effecting: bool = False, crash: bool = False
) -> ToolDescriptor:
    async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
        calls.append(name)
        if crash:
            raise _Crash
        return ToolInvocationResult(text=f"{name} ran", summary="ok")

    return ToolDescriptor(
        name=name,
        description="",
        input_schema={"type": "object"},
        execute=execute,
        side_effecting=side_effecting,
    )


def _tool_use(tool_id: str, name: str) -> dict[str, Any]:
    return {"type": "tool_use", "id": tool_id, "name": name, "input": {}}


def _result(tool_id: str, text: str) -> dict[str, Any]:
    return {"type": "tool_result", "tool_use_id": tool_id, "content": text}


def _provider_step_fn(client: _FakeClient, tools: list[ToolDescriptor]) -> Any:
    def make(_p: Any, _c: Any, messages: list[dict[str, Any]], _ctx: Any = None) -> RunStepFn:
        return make_anthropic_step_fn(
            AnthropicStepConfig(
                client=client, model="m", system=None, messages=messages, tools=tools
            )
        )

    return make


def _done_step_fn(seen: list[list[dict[str, Any]]]) -> Any:
    def make(_p: Any, _c: Any, messages: list[dict[str, Any]], _ctx: Any = None) -> RunStepFn:
        async def step(ctx: RunStepContext) -> RunStepOutcome:
            seen.append(list(messages))
            await ctx.emitter.token("answer")
            return RunStepOutcome(done=True)

        return step

    return make


@contextmanager
def _db(
    checkpoint: dict[str, Any] | None,
    *,
    max_seq: int,
    sink: Any,
    registry: dict[str, ToolDescriptor] | None = None,
) -> Iterator[dict[str, AsyncMock]]:
    """Patch every DB edge the executor touches; yields the write mocks."""
    mocks = {
        "save_checkpoint": AsyncMock(),
        "update_run": AsyncMock(),
        "claim_paused_for_respond": AsyncMock(return_value=True),
        "settle": AsyncMock(return_value=MagicMock()),
    }
    with ExitStack() as stack:
        for p in (
            patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
            patch.object(store, "max_event_seq", new=AsyncMock(return_value=max_seq)),
            patch.object(store, "set_task_handler", new=AsyncMock()),
            patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
            patch.object(store, "load_run_events", new=AsyncMock(return_value=[])),
            patch.object(store, "save_checkpoint", new=mocks["save_checkpoint"]),
            patch.object(store, "update_run", new=mocks["update_run"]),
            patch.object(store, "claim_paused_for_respond", new=mocks["claim_paused_for_respond"]),
            patch("agent_py.executor.settle_task_terminal", new=mocks["settle"]),
            patch("agent_py.executor._make_db_sink", return_value=sink),
        ):
            stack.enter_context(p)
        if registry is not None:
            stack.enter_context(
                patch("agent_py.executor.default_tool_registry", return_value=registry)
            )
        yield mocks


def _saved(save: AsyncMock) -> list[dict[str, Any]]:
    return [c.kwargs["checkpoint"] for c in save.await_args_list]


# --- 1. the execution record --------------------------------------------------


@pytest.mark.asyncio
async def test_side_effecting_tool_is_bracketed_by_an_execution_record() -> None:
    calls: list[str] = []
    tools = [_tool("read", calls), _tool("write", calls, side_effecting=True)]
    client = _FakeClient(
        deltas=[],
        final_content_seq=[[_tool_use("tu_r", "read"), _tool_use("tu_w", "write")], []],
    )
    _, sink = _list_sink()
    checkpoint = {"messages": [{"role": "user", "content": "go"}], "step": 0, "seq": 1}
    with _db(checkpoint, max_seq=1, sink=sink) as db:
        outcome = await executor.execute_start(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_provider_step_fn(client, tools),
        )

    assert outcome.settled is True
    assert calls == ["read", "write"]
    started, finished = _saved(db["save_checkpoint"])
    # Before `write` ran: the turn's assistant message is the last one,
    # `read`'s result is already in, `write` is marked started.
    assert started["messages"][-1]["role"] == "assistant"
    assert started["inflight_tools"] == {
        "started": ["tu_w"],
        "results": [_result("tu_r", "read ran")],
    }
    assert finished["inflight_tools"] == {
        "started": [],
        "results": [_result("tu_r", "read ran"), _result("tu_w", "write ran")],
    }
    # The record's seq covers the tool's output, so a resume keeps it.
    assert finished["seq"] > started["seq"]


@pytest.mark.asyncio
async def test_read_only_tools_write_no_record() -> None:
    calls: list[str] = []
    client = _FakeClient(deltas=[], final_content_seq=[[_tool_use("tu_r", "read")], []])
    _, sink = _list_sink()
    checkpoint = {"messages": [{"role": "user", "content": "go"}], "step": 0, "seq": 1}
    with _db(checkpoint, max_seq=1, sink=sink) as db:
        outcome = await executor.execute_start(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_provider_step_fn(client, [_tool("read", calls)]),
        )
    assert outcome.settled is True
    assert calls == ["read"]
    db["save_checkpoint"].assert_not_called()


@pytest.mark.asyncio
async def test_approval_gated_names_count_as_side_effecting() -> None:
    ledger = tool_ledger.ToolLedger(save=AsyncMock(), gated_tool_names=frozenset({"danger"}))
    assert ledger.is_side_effecting("danger", _tool("danger", []))
    assert ledger.is_side_effecting("mcp", _tool("mcp", [], side_effecting=True))
    assert not ledger.is_side_effecting("webFetch", _tool("webFetch", []))


def test_read_record_is_defensive() -> None:
    assert tool_ledger.read_record({}).empty
    assert tool_ledger.read_record({"inflight_tools": "x"}).empty
    rec = tool_ledger.read_record(
        {
            "inflight_tools": {
                "started": ["a", 3, ""],
                "results": [_result("b", "ok"), {"type": "text"}, "junk"],
            }
        }
    )
    assert rec.started == frozenset({"a"})
    assert list(rec.results) == ["b"]


# --- 2. reclaimed mid-turn ----------------------------------------------------


@pytest.mark.asyncio
async def test_crash_mid_side_effecting_tool_is_not_rerun_on_reclaim() -> None:
    """End to end: the worker dies while `write` runs; the reclaimed
    `start` resumes from the record, does not call `write` again, hands
    the model an "interrupted" result, and settles."""
    calls: list[str] = []
    client = _FakeClient(deltas=[], final_content_seq=[[_tool_use("tu_w", "write")], []])
    _, sink = _list_sink()
    checkpoint = {"messages": [{"role": "user", "content": "go"}], "step": 0, "seq": 1}
    with _db(checkpoint, max_seq=1, sink=sink) as db, pytest.raises(_Crash):
        await executor.execute_start(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_provider_step_fn(
                client, [_tool("write", calls, side_effecting=True, crash=True)]
            ),
        )
    assert calls == ["write"]
    (dead_checkpoint,) = _saved(db["save_checkpoint"])
    assert dead_checkpoint["inflight_tools"]["started"] == ["tu_w"]

    # Reclaim against what the dead attempt persisted.
    rerun_calls: list[str] = []
    collected, sink2 = _list_sink()
    seen: list[list[dict[str, Any]]] = []
    with _db(
        dead_checkpoint,
        max_seq=dead_checkpoint["seq"] + 2,
        sink=sink2,
        registry={"write": _tool("write", rerun_calls, side_effecting=True)},
    ) as db2:
        outcome = await executor.execute_start(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step_fn(seen),
            reclaimed=True,
        )

    assert outcome.settled is True
    assert rerun_calls == []
    last_turn = seen[0][-1]
    assert last_turn["role"] == "user"
    assert last_turn["content"] == [tool_ledger.interrupted_tool_result("tu_w")]
    # Marker first (dropping the dead attempt's events past the record),
    # then the interrupted output, the dead step closed, the next step.
    marker = collected[0]
    assert isinstance(marker, StatusEvent)
    assert marker.resumed_from_seq == dead_checkpoint["seq"]
    kinds = [type(e) for e in collected[:5]]
    assert kinds == [StatusEvent, StepErrorEvent, ToolOutputEvent, StepEndEvent, StepStartEvent]
    out = collected[2]
    assert isinstance(out, ToolOutputEvent)
    assert out.summary == tool_ledger.INTERRUPTED_TOOL_SUMMARY
    assert out.step == dead_checkpoint["step"]
    # The completed turn is checkpointed without the record.
    completed = _saved(db2["save_checkpoint"])[0]
    assert "inflight_tools" not in completed
    assert db2["settle"].await_args.kwargs["status"] == "done"


@pytest.mark.asyncio
async def test_reclaim_reuses_recorded_results_and_reruns_read_only_calls() -> None:
    """Turn = [write (finished), send (started, cut off), read, post].
    `write` reuses its recorded result, `send` is reported interrupted,
    `read` (read-only) runs again, `post` (side-effecting, never
    started) runs for the first time."""
    calls: list[str] = []
    registry = {
        "write": _tool("write", calls, side_effecting=True),
        "send": _tool("send", calls, side_effecting=True),
        "read": _tool("read", calls),
        "post": _tool("post", calls, side_effecting=True),
    }
    checkpoint = {
        "messages": [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "on it"},
                    _tool_use("tu_w", "write"),
                    _tool_use("tu_s", "send"),
                    _tool_use("tu_r", "read"),
                    _tool_use("tu_p", "post"),
                ],
            },
        ],
        "step": 1,
        "seq": 9,
        "config": {},
        "inflight_tools": {"started": ["tu_s"], "results": [_result("tu_w", "write ran")]},
    }
    collected, sink = _list_sink()
    seen: list[list[dict[str, Any]]] = []
    with _db(checkpoint, max_seq=12, sink=sink, registry=registry) as db:
        outcome = await executor.execute_continue(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step_fn(seen),
            reclaimed=True,
        )

    assert outcome.settled is True
    assert calls == ["read", "post"]
    assert seen[0][-1]["content"] == [
        _result("tu_w", "write ran"),
        tool_ledger.interrupted_tool_result("tu_s"),
        _result("tu_r", "read ran"),
        _result("tu_p", "post ran"),
    ]
    # `post` ran under the ledger: record before, result after, then the
    # completed turn's plain checkpoint.
    saves = _saved(db["save_checkpoint"])
    assert saves[0]["inflight_tools"]["started"] == ["tu_p"]
    assert saves[1]["inflight_tools"]["started"] == []
    assert "inflight_tools" not in saves[2]
    inputs = [e.tool_call_id for e in collected if isinstance(e, ToolInputEvent)]
    assert inputs == ["tu_r", "tu_p"]


@pytest.mark.asyncio
async def test_normal_resume_without_a_dangling_turn_is_unchanged() -> None:
    calls: list[str] = []
    checkpoint = {
        "messages": [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": [_tool_use("tu_r", "read")]},
            {"role": "user", "content": [_result("tu_r", "read ran")]},
        ],
        "step": 1,
        "seq": 6,
        "config": {},
    }
    collected, sink = _list_sink()
    seen: list[list[dict[str, Any]]] = []
    with _db(checkpoint, max_seq=6, sink=sink, registry={"read": _tool("read", calls)}) as db:
        await executor.execute_continue(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step_fn(seen),
        )
    assert calls == []
    assert seen[0] == checkpoint["messages"]
    assert isinstance(collected[0], StepStartEvent)
    db["save_checkpoint"].assert_not_called()


# --- 3. reclaimed respond -----------------------------------------------------


def _paused_on(tool: str, *, record: dict[str, Any] | None = None) -> dict[str, Any]:
    cp: dict[str, Any] = {
        "messages": [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": [_tool_use("tu_1", tool)]},
        ],
        "step": 1,
        "seq": 8,
        "config": {"requireApprovalFor": ["danger"]},
    }
    if record is not None:
        cp["inflight_tools"] = record
    return cp


@pytest.mark.asyncio
async def test_reclaimed_respond_does_not_rerun_a_started_approved_tool() -> None:
    calls: list[str] = []
    collected, sink = _list_sink()
    seen: list[list[dict[str, Any]]] = []
    checkpoint = _paused_on("danger", record={"started": ["tu_1"], "results": []})
    with _db(checkpoint, max_seq=10, sink=sink, registry={"danger": _tool("danger", calls)}) as db:
        outcome = await executor.execute_respond(
            MagicMock(),
            executor.RespondActionPayload(
                run_id=RUN_ID, user_id=USER_ID, request_id="tu_1", approved=True
            ),
            make_step_fn=_done_step_fn(seen),
            resume_interrupted=True,
        )

    assert outcome.settled is True
    assert calls == []
    db["claim_paused_for_respond"].assert_not_called()
    interrupted = tool_ledger.interrupted_tool_result("tu_1")
    assert seen[0][-1] == {"role": "user", "content": [interrupted]}
    persisted = _saved(db["save_checkpoint"])[0]
    assert persisted["messages"][-1]["content"] == [interrupted]
    assert "inflight_tools" not in persisted
    errors = [e for e in collected if isinstance(e, StepErrorEvent)]
    assert len(errors) == 1 and "not run again" in errors[0].message
    assert db["settle"].await_args.kwargs["status"] == "done"


@pytest.mark.asyncio
async def test_first_respond_records_the_approved_tool_before_running_it() -> None:
    order: list[str] = []
    calls: list[str] = []
    _, sink = _list_sink()

    async def save(_pool: Any, **kw: Any) -> None:
        order.append("record" if "inflight_tools" in kw["checkpoint"] else "persist")

    async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
        order.append("execute")
        calls.append("danger")
        return ToolInvocationResult(text="done", summary="ok")

    danger = ToolDescriptor(
        name="danger", description="", input_schema={"type": "object"}, execute=execute
    )
    with _db(_paused_on("danger"), max_seq=8, sink=sink, registry={"danger": danger}) as db:
        db["save_checkpoint"].side_effect = save
        outcome = await executor.execute_respond(
            MagicMock(),
            executor.RespondActionPayload(
                run_id=RUN_ID, user_id=USER_ID, request_id="tu_1", approved=True
            ),
            make_step_fn=_done_step_fn([]),
        )
    assert outcome.settled is True
    assert order == ["record", "execute", "persist"]


@pytest.mark.asyncio
async def test_declined_respond_writes_no_record() -> None:
    calls: list[str] = []
    _, sink = _list_sink()
    with _db(
        _paused_on("danger"), max_seq=8, sink=sink, registry={"danger": _tool("danger", calls)}
    ) as db:
        await executor.execute_respond(
            MagicMock(),
            executor.RespondActionPayload(
                run_id=RUN_ID, user_id=USER_ID, request_id="tu_1", approved=False
            ),
            make_step_fn=_done_step_fn([]),
        )
    assert calls == []
    assert all("inflight_tools" not in cp for cp in _saved(db["save_checkpoint"]))


# --- 4. reclaimed suspend checkpoint -------------------------------------------


@pytest.mark.asyncio
async def test_reclaimed_start_on_a_suspend_checkpoint_pauses_again() -> None:
    """The dead attempt saved its suspend checkpoint but never flipped the
    row to `paused`: the reclaim re-requests approval instead of running
    the model past the unanswered call."""
    calls: list[str] = []
    collected, sink = _list_sink()
    seen: list[list[dict[str, Any]]] = []
    with _db(
        _paused_on("danger"), max_seq=8, sink=sink, registry={"danger": _tool("danger", calls)}
    ) as db:
        outcome = await executor.execute_start(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step_fn(seen),
            reclaimed=True,
        )

    assert outcome.settled is True
    assert seen == [] and calls == []
    marker, request, paused = collected
    assert isinstance(marker, StatusEvent)
    assert (marker.status, marker.resumed_from_seq, marker.seq) == ("running", 8, 9)
    assert isinstance(request, ApprovalEvent)
    assert (request.phase, request.approval_id, request.request_kind, request.tool) == (
        "request",
        "tu_1",
        "approval",
        "danger",
    )
    assert isinstance(paused, StatusEvent) and paused.status == "paused"
    saved = _saved(db["save_checkpoint"])[-1]
    assert saved["seq"] == paused.seq
    assert saved["messages"][-1]["content"] == [_tool_use("tu_1", "danger")]
    db["update_run"].assert_awaited_once()
    assert db["update_run"].await_args.kwargs["status"] == "paused"
    db["settle"].assert_not_called()
    assert not any(isinstance(e, ResultEvent) for e in collected)


@pytest.mark.asyncio
async def test_reclaimed_continue_on_an_ask_user_checkpoint_pauses_again() -> None:
    collected, sink = _list_sink()
    checkpoint = _paused_on("askUser")
    checkpoint["messages"][-1]["content"][0]["input"] = {"prompt": "Which one?"}
    with _db(checkpoint, max_seq=8, sink=sink) as db:
        await executor.execute_continue(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step_fn([]),
            reclaimed=True,
        )
    requests = [e for e in collected if isinstance(e, ApprovalEvent)]
    assert [(r.request_kind, r.prompt) for r in requests] == [("input", "Which one?")]
    assert db["update_run"].await_args.kwargs["status"] == "paused"


@pytest.mark.asyncio
async def test_reclaimed_respond_whose_run_resuspended_pauses_again() -> None:
    """The dead respond attempt persisted the answer, ran on, and saved a
    NEW suspend checkpoint before dying: resuming finds that call
    unanswered and pauses on it."""
    collected, sink = _list_sink()
    checkpoint = _paused_on("danger")
    checkpoint["messages"] += [
        {"role": "user", "content": [_result("tu_1", "did it")]},
        {"role": "assistant", "content": [_tool_use("tu_2", "danger")]},
    ]
    with _db(checkpoint, max_seq=14, sink=sink) as db:
        outcome = await executor.execute_respond(
            MagicMock(),
            executor.RespondActionPayload(
                run_id=RUN_ID, user_id=USER_ID, request_id="tu_1", approved=True
            ),
            make_step_fn=_done_step_fn([]),
            resume_interrupted=True,
        )
    assert outcome.settled is True
    requests = [e for e in collected if isinstance(e, ApprovalEvent)]
    assert [(r.phase, r.approval_id) for r in requests] == [("request", "tu_2")]
    assert db["update_run"].await_args.kwargs["status"] == "paused"
