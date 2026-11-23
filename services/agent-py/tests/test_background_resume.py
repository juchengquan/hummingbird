"""The background executor, wave 5b-A — hermetic (store writes patched,
the step fn injected through `make_step_fn`).

* Q41: a runs-API resume run's `start` applies the stored answers (an
  approval approved / denied, an ask-user answer, a cancelled question)
  in a step of its own, then continues from the paused checkpoint; an
  answer to a call the run never paused on fails the run; a reclaimed
  attempt that got past an approved tool's start never runs it again
  and never asks again.
* Q46: a research run gets the research task prompt.
* Skills, reasoning effort and `allowedMcpServerIds` (Q48) in the tool set.
* `tasks.step` written at each step's end.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
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
    ToolOutputEvent,
)
from agent_py.resume_answers import DECLINED_ANSWER, DECLINED_APPROVAL, RESUME_KEY
from agent_py.runner import RunStepContext, RunStepFn, RunStepOutcome
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

from .executor_fakes import fake_settle

RUN_ID = "44444444-4444-4444-4444-444444444444"
USER_ID = "55555555-5555-5555-5555-555555555555"
PAYLOAD = executor.StartActionPayload(run_id=RUN_ID, user_id=USER_ID)


def _assistant_call(call_id: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": [{"type": "tool_use", "id": call_id, "name": name, "input": args}],
    }


def _resume_checkpoint(
    call: dict[str, Any], answer: dict[str, Any], **config: Any
) -> dict[str, Any]:
    return {
        "messages": [{"role": "user", "content": "Do the thing"}, call],
        "config": {"model": "anthropic/claude-haiku-4.5", "maxSteps": 5, **config},
        "step": 0,
        "seq": 1,
        RESUME_KEY: {"previousRunId": "prev", "answers": [answer]},
    }


class _Recorder:
    """A step fn that records the model input of each step and settles."""

    def __init__(self) -> None:
        self.seen: list[list[dict[str, Any]]] = []

    def make(self, _p: Any, _c: Any, messages: list[Any], _ctx: Any = None) -> RunStepFn:
        async def step(_ctx: RunStepContext) -> RunStepOutcome:
            self.seen.append([dict(m) for m in messages])
            return RunStepOutcome(done=True)

        return step


class _Harness:
    def __init__(self) -> None:
        self.events: list[TaskEvent] = []
        self.save = AsyncMock()
        self.update_run = AsyncMock()
        self.settle = fake_settle(self.events)

    @contextlib.contextmanager
    def patched(self, checkpoint: dict[str, Any], run_tools: Any | None = None) -> Iterator[None]:
        async def sink(event: TaskEvent) -> None:
            self.events.append(event)

        with contextlib.ExitStack() as stack:
            stack.enter_context(
                patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint))
            )
            stack.enter_context(patch.object(store, "max_event_seq", new=AsyncMock(return_value=1)))
            stack.enter_context(
                patch.object(store, "load_run_events", new=AsyncMock(return_value=[]))
            )
            stack.enter_context(patch.object(store, "set_task_handler", new=AsyncMock()))
            stack.enter_context(
                patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False))
            )
            stack.enter_context(patch.object(store, "update_run", new=self.update_run))
            stack.enter_context(patch.object(store, "save_checkpoint", new=self.save))
            stack.enter_context(patch("agent_py.executor._make_db_sink", return_value=sink))
            stack.enter_context(patch("agent_py.executor.settle_task_terminal", new=self.settle))
            stack.enter_context(
                patch("agent_py.executor._maybe_verify", new=AsyncMock(return_value=None))
            )
            if run_tools is not None:
                stack.enter_context(
                    patch(
                        "agent_py.executor._build_run_tools", new=AsyncMock(return_value=run_tools)
                    )
                )
            yield

    def of(self, kind: type[Any]) -> list[Any]:
        return [e for e in self.events if isinstance(e, kind)]


def _send_tool(calls: list[dict[str, Any]]) -> ToolDescriptor:
    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        calls.append(dict(args))
        return ToolInvocationResult(text=f"sent to {args.get('to')}", summary="Sent")

    return ToolDescriptor(
        name="send",
        description="Send a message",
        input_schema={"type": "object"},
        execute=execute,
        side_effecting=True,
    )


def _tools(extra: dict[str, ToolDescriptor]) -> Any:
    return executor._RunTools(context=None, extra_tools=extra, mcp_gated=set())


def _last_user_results(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    last = messages[-1]
    assert last["role"] == "user" and isinstance(last["content"], list)
    return last["content"]


# --- Q41: answers ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ask_user_answer_becomes_the_tool_result_then_the_run_continues() -> None:
    h, rec = _Harness(), _Recorder()
    cp = _resume_checkpoint(
        _assistant_call("call-ask", "askUser", {"prompt": "Which colour?"}),
        {"interruptId": "call-ask", "status": "resolved", "payload": {"value": "blue"}},
    )
    with h.patched(cp):
        outcome = await executor.execute_start(MagicMock(), PAYLOAD, make_step_fn=rec.make)
    assert outcome.settled is True
    # The model's first step sees the paused turn + the answer.
    results = _last_user_results(rec.seen[0])
    assert results == [{"type": "tool_result", "tool_use_id": "call-ask", "content": "blue"}]
    assert rec.seen[0][:2] == cp["messages"]
    # Events: running, the answers' step (one tool_output), then the model's step.
    kinds = [type(e).__name__ for e in h.events]
    assert kinds[:4] == ["StatusEvent", "StepStartEvent", "ToolOutputEvent", "StepEndEvent"]
    out = h.of(ToolOutputEvent)[0]
    assert out.tool_call_id == "call-ask" and out.output == "blue"
    assert h.events[0].seq == 2  # past the route's `status: queued` (seq 1)
    # A Q24 resume writes no in-place `approval: response` entry.
    assert not h.of(ApprovalEvent)
    assert h.of(ResultEvent)[0].status == "done"
    # The answers are saved into the checkpoint, without the resume block:
    # first with the turn's record, then as the completed turn.
    assert RESUME_KEY not in h.save.await_args_list[0].kwargs["checkpoint"]
    saved = h.save.await_args_list[-1].kwargs["checkpoint"]
    assert RESUME_KEY not in saved and saved["step"] == 1
    assert _last_user_results(saved["messages"])[0]["content"] == "blue"
    assert h.settle.await_args.kwargs["status"] == "done"


@pytest.mark.asyncio
async def test_approved_tool_runs_with_the_edited_args_once() -> None:
    h, rec, calls = _Harness(), _Recorder(), []
    cp = _resume_checkpoint(
        _assistant_call("call-send", "send", {"to": "alice"}),
        {
            "interruptId": "call-send",
            "status": "resolved",
            "payload": {"approved": True, "args": {"to": "bob"}},
        },
        requireApprovalFor=["send"],
    )
    with h.patched(cp, run_tools=_tools({"send": _send_tool(calls)})):
        await executor.execute_start(MagicMock(), PAYLOAD, make_step_fn=rec.make)
    assert calls == [{"to": "bob"}]
    results = _last_user_results(rec.seen[0])
    assert results[0]["tool_use_id"] == "call-send" and results[0]["content"] == "sent to bob"
    assert h.of(ToolOutputEvent)[0].summary == "Sent"
    # The side effect was recorded before it ran (`tool_ledger`).
    inflight = [
        c.kwargs["checkpoint"]
        for c in h.save.await_args_list
        if tool_ledger.INFLIGHT_KEY in c.kwargs["checkpoint"]
    ]
    assert inflight and inflight[0][tool_ledger.INFLIGHT_KEY]["started"] == ["call-send"]


@pytest.mark.asyncio
async def test_denied_and_cancelled_approvals_run_nothing() -> None:
    for answer in (
        {"interruptId": "call-send", "status": "resolved", "payload": {"approved": False}},
        {"interruptId": "call-send", "status": "cancelled"},
    ):
        h, rec, calls = _Harness(), _Recorder(), []
        cp = _resume_checkpoint(
            _assistant_call("call-send", "send", {"to": "alice"}),
            answer,
            requireApprovalFor=["send"],
        )
        with h.patched(cp, run_tools=_tools({"send": _send_tool(calls)})):
            await executor.execute_start(MagicMock(), PAYLOAD, make_step_fn=rec.make)
        assert calls == []
        assert _last_user_results(rec.seen[0])[0]["content"] == DECLINED_APPROVAL
        assert h.of(ToolOutputEvent)[0].summary == "Declined by the user"


@pytest.mark.asyncio
async def test_choice_and_cancelled_questions() -> None:
    choice = _assistant_call(
        "call-pick",
        "askUser",
        {"prompt": "Pick", "options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}]},
    )
    for answer, expected in (
        (
            {"interruptId": "call-pick", "status": "resolved", "payload": {"selection": ["b"]}},
            "User selected: b",
        ),
        ({"interruptId": "call-pick", "status": "cancelled"}, DECLINED_ANSWER),
    ):
        h, rec = _Harness(), _Recorder()
        with h.patched(_resume_checkpoint(choice, answer)):
            await executor.execute_start(MagicMock(), PAYLOAD, make_step_fn=rec.make)
        assert _last_user_results(rec.seen[0])[0]["content"] == expected


@pytest.mark.asyncio
async def test_an_answer_to_a_call_the_run_never_paused_on_fails_the_run() -> None:
    h, rec, calls = _Harness(), _Recorder(), []
    cp = _resume_checkpoint(
        _assistant_call("call-send", "send", {"to": "alice"}),
        {"interruptId": "call-send", "status": "resolved", "payload": {"approved": True}},
        # `send` is not gated in this run's config.
    )
    with h.patched(cp, run_tools=_tools({"send": _send_tool(calls)})):
        outcome = await executor.execute_start(MagicMock(), PAYLOAD, make_step_fn=rec.make)
    assert outcome.settled is False and "not awaiting user input" in (outcome.error or "")
    assert calls == [] and rec.seen == []
    assert h.of(ResultEvent)[0].status == "failed"
    assert h.settle.await_args.kwargs["status"] == "failed"


@pytest.mark.asyncio
async def test_reclaimed_after_the_approved_tool_started_neither_reruns_nor_asks_again() -> None:
    """The dead attempt recorded the approved tool as started (its checkpoint
    has no resume block any more and `step > 0`): the reclaim finishes the
    turn with "interrupted, outcome unknown" instead of re-pausing."""
    h, rec, calls = _Harness(), _Recorder(), []
    cp = {
        "messages": [
            {"role": "user", "content": "Do the thing"},
            _assistant_call("call-send", "send", {"to": "alice"}),
        ],
        "config": {"model": "anthropic/claude-haiku-4.5", "requireApprovalFor": ["send"]},
        "step": 1,
        "seq": 4,
        tool_ledger.INFLIGHT_KEY: tool_ledger.record_payload(["call-send"], []),
    }
    with h.patched(cp, run_tools=_tools({"send": _send_tool(calls)})):
        outcome = await executor.execute_start(
            MagicMock(), PAYLOAD, make_step_fn=rec.make, reclaimed=True
        )
    assert outcome.settled is True
    assert calls == []
    assert not h.of(ApprovalEvent)  # not asked again
    assert h.of(StepErrorEvent)
    assert _last_user_results(rec.seen[0])[0]["tool_use_id"] == "call-send"
    assert h.of(ResultEvent)[0].status == "done"


# --- progress ------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_step_is_written_at_each_step_end() -> None:
    h, rec = _Harness(), _Recorder()
    cp = _resume_checkpoint(
        _assistant_call("call-ask", "askUser", {"prompt": "?"}),
        {"interruptId": "call-ask", "status": "resolved", "payload": {"value": "x"}},
    )
    with h.patched(cp):
        await executor.execute_start(MagicMock(), PAYLOAD, make_step_fn=rec.make)
    steps = [c.kwargs["step"] for c in h.update_run.await_args_list if "step" in c.kwargs]
    assert steps[:2] == [1, 2]
    assert len(h.of(StepStartEvent)) == len(h.of(StepEndEvent)) == 2
    assert h.of(StatusEvent)[0].status == "running"


# --- the step fn: research prompt, skills, reasoning effort -------------------------


class _Client:
    messages = MagicMock()


def _step_config(checkpoint: dict[str, Any], run_tools: Any | None = None) -> Any:
    captured: dict[str, Any] = {}

    def fake_make(config: Any) -> Any:
        captured["config"] = config
        return MagicMock()

    with (
        patch.object(executor, "_resolve_anthropic_client", return_value=_Client()),
        patch.object(executor, "make_anthropic_step_fn", side_effect=fake_make),
    ):
        executor._default_make_step_fn(
            PAYLOAD, checkpoint, [{"role": "user", "content": "hi"}], run_tools=run_tools
        )
    return captured["config"]


def _cfg(**config: Any) -> dict[str, Any]:
    return {"messages": [], "config": {"model": "anthropic/claude-haiku-4.5", **config}}


def test_research_runs_get_the_research_prompt() -> None:
    research = _step_config(_cfg(mode="research", workspaceSystemPrompt="  Be terse.  "))
    assert research.system.startswith("Be terse.\n\nYou are a research agent")
    assert "## Sources" in research.system and "setPlan" not in research.system
    assert "Use `webSearch` to find candidate sources" in research.system
    default = _step_config(_cfg(mode="default", workspaceSystemPrompt="Be terse."))
    assert default.system == "Be terse."
    assert _step_config(_cfg()).system is None


def test_research_prompt_goes_files_first_with_search_files() -> None:
    ctx = executor.ToolContext(pool=MagicMock(), user_id=USER_ID, workspace_id="ws")
    cp = _cfg(mode="research", skills=[{"id": "searchFiles"}])
    tools = executor._RunTools(
        context=ctx, extra_tools={}, mcp_gated=set(), skill_tool_names=frozenset({"searchFiles"})
    )
    assert "call `searchFiles({ fileId, query })` first" in _step_config(cp, tools).system


def test_only_the_chosen_skills_are_offered() -> None:
    names = {t.name for t in _step_config(_cfg(skills=[{"id": "webFetch"}])).tools}
    assert "webFetch" in names
    assert {"askUser", "renderUI", "spawnSubagent"} <= names
    assert not names & {"webSearch", "generateImage", "searchFiles"}
    none = {t.name for t in _step_config(_cfg()).tools}
    assert "webFetch" not in none and "askUser" in none


def test_reasoning_effort_turns_on_thinking() -> None:
    cfg = _step_config(_cfg(reasoningEffort="low"))
    assert cfg.thinking is not None
    assert cfg.thinking.thinking == {"type": "enabled", "budget_tokens": 2048}
    assert _step_config(_cfg()).thinking is None


# --- allowedMcpServerIds (Q48) -------------------------------------------------------


@pytest.mark.asyncio
async def test_build_run_tools_passes_the_mcp_allow_list() -> None:
    for config, expected in (
        ({}, None),
        ({"allowedMcpServerIds": []}, ()),
        ({"allowedMcpServerIds": ["s1", "s1", "s2"]}, ("s1", "s2")),
    ):
        extend = AsyncMock()
        with patch("agent_py.executor.extend_registry_with_mcp", new=extend):
            await executor._build_run_tools(
                MagicMock(),
                user_id=USER_ID,
                checkpoint={"config": {"workspaceId": "ws", **config}},
                discover_mcp=True,
            )
        assert extend.await_args.kwargs["allowed_server_ids"] == expected
