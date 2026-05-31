"""Phase 3b tests — suspend path + respond action end-to-end.

Two flows:

  - **Suspend**: the step fn detects a gated tool call, captures it
    as `pending_input`, returns without executing. The runner returns
    `kind="suspended"` carrying the descriptor. The executor saves
    a fresh checkpoint, emits `approval: request` + `status: paused`,
    and updates the `tasks` row to paused.

  - **Respond**: the next job arrives with `{requestId, approved?,
    selection?, value?}`. The executor loads the checkpoint, finds
    the pending tool_use block by id, builds a `tool_result` from
    the user's answer, appends it as a user turn, emits
    `input_response`, then resumes the loop with seeded emitter
    seq/step.

All hermetic — store + jobs writes are patched; the step fn is
injected via the `make_step_fn` seam.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import executor, store
from agent_py.emitter import RunEmitter
from agent_py.events import (
    ApprovalEvent,
    StatusEvent,
    TaskEvent,
    ToolInputEvent,
)
from agent_py.runner import (
    PendingInputDescriptor,
    RunStepContext,
    RunStepFn,
    RunStepOutcome,
    run_agent_loop,
)

# --- Runner: suspended kind --------------------------------------------


def _list_sink() -> tuple[list[TaskEvent], RunEmitter]:
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    emitter = RunEmitter(run_id="r1", sink=sink)
    return collected, emitter


@pytest.mark.asyncio
async def test_run_loop_returns_suspended_when_step_has_pending_input() -> None:
    """A step that returns RunStepOutcome with pending_input → runner
    returns kind="suspended" carrying the descriptor. No terminal
    event emitted."""

    async def fake_step(_ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(
            done=False,
            pending_input=PendingInputDescriptor(
                tool_call_id="tu_42",
                tool="myMcp__danger",
                args={"target": "production"},
            ),
        )

    async def is_cancelled() -> bool:
        return False

    collected, emitter = _list_sink()
    result = await run_agent_loop(
        emitter=emitter,
        max_steps=5,
        run_step=fake_step,
        is_cancelled=is_cancelled,
    )

    assert result.kind == "suspended"
    assert result.pending_input is not None
    assert result.pending_input.tool_call_id == "tu_42"
    assert result.pending_input.tool == "myMcp__danger"
    # No terminal `result` emit on suspend.
    assert all(e.kind != "result" for e in collected)


# --- Executor: suspend path -------------------------------------------


def _make_suspend_step(
    *,
    tool_call_id: str,
    tool: str,
) -> tuple[list[int], executor.MakeStepFn]:
    """Build a MakeStepFn whose step returns a pending_input on first
    call, simulating a gated tool detected by the Anthropic provider."""
    called: list[int] = []

    def make(_p: Any, _c: Any, messages: list[Any], _ctx: Any = None) -> RunStepFn:
        async def step(ctx: RunStepContext) -> RunStepOutcome:
            called.append(ctx.step)
            # Mimic the provider's behaviour: append the assistant
            # turn with the pending tool_use before suspending.
            messages.append(
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": tool_call_id,
                            "name": tool,
                            "input": {"target": "prod"},
                        }
                    ],
                }
            )
            return RunStepOutcome(
                done=False,
                pending_input=PendingInputDescriptor(
                    tool_call_id=tool_call_id,
                    tool=tool,
                    args={"target": "prod"},
                ),
            )

        return step

    return called, make


@pytest.mark.asyncio
async def test_executor_suspend_saves_checkpoint_and_emits_approval() -> None:
    pool = MagicMock()
    payload = executor.StartActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
    )
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    _, make_step = _make_suspend_step(tool_call_id="tu_1", tool="myMcp__write")

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value={
                    "messages": [{"role": "user", "content": "go"}],
                    "config": {
                        "model": "claude-sonnet-4-6",
                        "requireApprovalFor": ["myMcp__write"],
                    },
                }
            ),
        ),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()) as update_run,
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_checkpoint,
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        outcome = await executor.execute_start(pool, payload, make_step_fn=make_step)

    assert outcome.settled is True
    save_checkpoint.assert_awaited_once()
    saved = save_checkpoint.await_args.kwargs["checkpoint"]
    # The assistant turn with the pending tool_use was preserved.
    assert any(m.get("role") == "assistant" for m in saved["messages"])

    # `update_run` was called with status="paused".
    update_run.assert_awaited_once()
    assert update_run.await_args.kwargs["status"] == "paused"

    # Approval-request event was emitted with the right tool info.
    approval_requests = [
        e for e in collected if isinstance(e, ApprovalEvent) and e.phase == "request"
    ]
    assert len(approval_requests) == 1
    assert approval_requests[0].tool == "myMcp__write"
    assert approval_requests[0].tool_call_id == "tu_1"

    # And the status:paused event followed.
    paused_statuses = [e for e in collected if isinstance(e, StatusEvent) and e.status == "paused"]
    assert len(paused_statuses) == 1


# --- Executor: respond path -------------------------------------------


def _checkpoint_with_pending(*, tool_call_id: str, tool: str) -> dict[str, Any]:
    """A checkpoint shape that mimics what `execute_start` would
    have saved after a suspend — assistant turn with a pending
    tool_use block."""
    return {
        "messages": [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "I need to write to prod."},
                    {
                        "type": "tool_use",
                        "id": tool_call_id,
                        "name": tool,
                        "input": {"target": "prod"},
                    },
                ],
            },
        ],
        "step": 1,
        "seq": 8,
        "config": {
            "model": "claude-sonnet-4-6",
            "requireApprovalFor": [tool],
        },
    }


@pytest.mark.asyncio
async def test_respond_with_approved_false_appends_decline_message() -> None:
    pool = MagicMock()
    payload = executor.RespondActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        request_id="tu_1",
        approved=False,
    )
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    # Step fn settles immediately after the model sees the decline.
    def make(_p: Any, _c: Any, _messages: list[Any], _ctx: Any = None) -> RunStepFn:
        async def step(_ctx: RunStepContext) -> RunStepOutcome:
            return RunStepOutcome(done=True)

        return step

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value=_checkpoint_with_pending(tool_call_id="tu_1", tool="myMcp__write")
            ),
        ),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()) as update_run,
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_checkpoint,
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        outcome = await executor.execute_respond(pool, payload, make_step_fn=make)

    assert outcome.settled is True
    # Checkpoint saved at least once (the interim save with the
    # appended tool_result, before the resume loop).
    save_checkpoint.assert_awaited()
    saved = save_checkpoint.await_args_list[0].kwargs["checkpoint"]
    # The user turn carries the tool_result with the decline message.
    user_turns = [m for m in saved["messages"] if m.get("role") == "user"]
    last_user = user_turns[-1]
    assert isinstance(last_user["content"], list)
    tool_result = last_user["content"][0]
    assert tool_result["type"] == "tool_result"
    assert tool_result["tool_use_id"] == "tu_1"
    assert "declined" in tool_result["content"].lower()
    # Run settled with status="done".
    assert any(call.kwargs.get("status") == "done" for call in update_run.await_args_list)

    # input_response emitted before the loop resumed.
    responses = [e for e in collected if isinstance(e, ApprovalEvent) and e.phase == "response"]
    assert len(responses) == 1
    assert responses[0].approved is False


@pytest.mark.asyncio
async def test_respond_with_approved_unknown_tool_feeds_placeholder() -> None:
    """`approved=True` on a tool we don't have a descriptor for (MCP
    tools aren't ported yet) → feeds the model a placeholder message
    rather than executing or failing."""
    pool = MagicMock()
    payload = executor.RespondActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        request_id="tu_1",
        approved=True,
    )

    async def sink(event: TaskEvent) -> None:
        pass

    def make(_p: Any, _c: Any, _messages: list[Any], _ctx: Any = None) -> RunStepFn:
        async def step(_ctx: RunStepContext) -> RunStepOutcome:
            return RunStepOutcome(done=True)

        return step

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value=_checkpoint_with_pending(tool_call_id="tu_1", tool="myMcp__write")
            ),
        ),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_checkpoint,
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        outcome = await executor.execute_respond(pool, payload, make_step_fn=make)

    assert outcome.settled is True
    saved = save_checkpoint.await_args_list[0].kwargs["checkpoint"]
    tool_result = [m for m in saved["messages"] if m.get("role") == "user"][-1]["content"][0]
    assert tool_result["type"] == "tool_result"
    # Placeholder message for unknown / unported tool.
    assert "Phase 3f" in tool_result["content"] or "not registered" in tool_result["content"]


@pytest.mark.asyncio
async def test_respond_missing_pending_returns_failure() -> None:
    pool = MagicMock()
    payload = executor.RespondActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        request_id="tu_GHOST",  # not present in checkpoint
        approved=True,
    )

    async def sink(event: TaskEvent) -> None:
        pass

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value=_checkpoint_with_pending(tool_call_id="tu_1", tool="myMcp__write")
            ),
        ),
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        outcome = await executor.execute_respond(pool, payload)

    assert outcome.settled is False
    assert outcome.error is not None
    assert "not found" in outcome.error


@pytest.mark.asyncio
async def test_respond_no_checkpoint_returns_failure() -> None:
    pool = MagicMock()
    payload = executor.RespondActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        request_id="tu_1",
        approved=True,
    )

    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=None)),
    ):
        outcome = await executor.execute_respond(pool, payload)

    assert outcome.settled is False
    assert outcome.error is not None


# --- Anthropic provider: gated-tool detection -------------------------


@pytest.mark.asyncio
async def test_anthropic_provider_suspends_on_gated_tool() -> None:
    """End-to-end provider check: a gated tool_use in the SDK's final
    message → step returns pending_input + does not execute the tool +
    a tool_input event is emitted (so the strip shows "awaiting
    approval")."""
    from agent_py.providers.anthropic_provider import (
        AnthropicStepConfig,
        make_anthropic_step_fn,
    )
    from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

    # We need the step to think `webFetch` is gated for this test.
    # `webFetch` actually exists in the default registry — we mark it
    # gated so the provider takes the suspend branch.
    invocations: list[dict[str, Any]] = []

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        invocations.append(args)
        return ToolInvocationResult(text="should not run", summary="x")

    gated_tool = ToolDescriptor(
        name="dangerTool",
        description="(test)",
        input_schema={"type": "object"},
        execute=execute,
    )

    # Reuse the _FakeClient from test_anthropic_provider for tools.
    from tests.test_anthropic_provider import _FakeClient

    client = _FakeClient(
        deltas=[],
        final_content_seq=[
            [
                {
                    "type": "tool_use",
                    "id": "tu_gated",
                    "name": "dangerTool",
                    "input": {"target": "prod"},
                },
            ],
        ],
    )
    collected, emitter = _list_sink()
    messages: list[dict[str, Any]] = [{"role": "user", "content": "go"}]
    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system=None,
            messages=messages,
            tools=[gated_tool],
            gated_tool_names={"dangerTool"},
        )
    )

    await emitter.start_step()
    outcome = await step(RunStepContext(step=emitter.step, emitter=emitter))

    assert outcome.done is False
    assert outcome.pending_input is not None
    assert outcome.pending_input.tool == "dangerTool"
    assert outcome.pending_input.tool_call_id == "tu_gated"
    assert invocations == []  # Tool was NOT executed.

    # Assistant turn appended (so the eventual tool_result on resume
    # has the matching tool_use to pair with).
    assert len(messages) == 2
    assert messages[1]["role"] == "assistant"

    # `tool_input` event emitted for the UI even though the tool
    # didn't run — the pill displays "awaiting approval".
    tool_inputs = [e for e in collected if isinstance(e, ToolInputEvent)]
    assert len(tool_inputs) == 1
    assert tool_inputs[0].tool_name == "dangerTool"
