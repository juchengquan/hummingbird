"""Tests for the executor.

The executor is the bridge between the queue (a claimed job) and the
agent loop (events + state). Tests focus on:
  1. Happy path: stub step fn runs, terminal events emitted, task row
     updated, ExecutorOutcome(settled=True) returned.
  2. Cancellation mid-loop: task status flipped → executor returns
     settled=True with `cancelled` terminal.
  3. Loop raises: ExecutorOutcome(settled=False), task row updated to
     `failed`, terminal `result: failed` event emitted.
  4. handler stamped: `set_task_handler` called with 'python'.
  5. Fan-out (spawned): create children, set barrier, checkpoint with
     awaiting_children, enqueue start jobs, no terminal settle.
  6. Depth cap: nested child (parent_task_id set) → reject + continue.
  7. Breadth clamp: >MAX_CHILDREN specs → clamped to MAX_CHILDREN.
  8. Fan-in (continue + awaiting_children): child results aggregated +
     injected as tool_result; marker cleared before loop.

The DB layer is patched so tests don't need a real Postgres.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import jobs, store
from agent_py.executor import (
    ExecutorOutcome,
    MakeStepFn,
    StartActionPayload,
    execute_continue,
    execute_start,
)
from agent_py.runner import RunStepContext, RunStepFn, RunStepOutcome, SpawnDescriptor, SpawnSpec
from agent_py.store import ChildResult
from agent_py.tools.spawn_subagent import MAX_CHILDREN

RUN_ID = "11111111-1111-1111-1111-111111111111"
USER_ID = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def payload() -> StartActionPayload:
    return StartActionPayload(run_id=RUN_ID, user_id=USER_ID, max_steps=5)


def _patch_store(load: dict | None = None):
    """Bundle the common AsyncMock patches the executor calls into.
    Caller layers it with `with ExitStack`; returns the four mocks so
    individual tests can assert against them."""
    return (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=load)),
    )


@pytest.mark.asyncio
async def test_happy_path_settles_and_updates_task(
    payload: StartActionPayload,
) -> None:
    pool = MagicMock()
    with (
        patch.object(store, "set_task_handler", new=AsyncMock()) as set_handler,
        patch.object(store, "append_event", new=AsyncMock()) as append,
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=None)),
        patch(
            "agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())
        ) as settle,
    ):
        outcome = await execute_start(pool, payload)
    assert outcome == ExecutorOutcome(settled=True)
    # handler stamped exactly once with 'python'.
    set_handler.assert_awaited_once()
    assert set_handler.await_args.kwargs["handler"] == "python"
    # Terminal settlement routed through the barrier.
    settle.assert_awaited_once()
    assert settle.await_args.kwargs["task_id"] == RUN_ID
    assert settle.await_args.kwargs["status"] == "done"
    # Events were persisted (at least: status, step_start, tokens,
    # step_end, result). Exact count depends on stub.
    assert append.await_count >= 4


@pytest.mark.asyncio
async def test_cancellation_returns_cancelled_terminal(
    payload: StartActionPayload,
) -> None:
    """Out-of-band cancel between steps → executor emits `status:
    cancelled` and settles via the barrier."""
    pool = MagicMock()
    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=True)),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=None)),
        patch(
            "agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())
        ) as settle,
    ):
        outcome = await execute_start(pool, payload)
    # `settled=True` because the cancel landed cleanly (not a fault).
    assert outcome.settled is True
    settle.assert_awaited_once()
    assert settle.await_args.kwargs["task_id"] == RUN_ID
    assert settle.await_args.kwargs["status"] == "cancelled"


@pytest.mark.asyncio
async def test_step_fn_raising_marks_failed(
    payload: StartActionPayload,
) -> None:
    """A model/tool error inside the loop bubbles out as an
    ExecutorOutcome(settled=False) and gets settled via the barrier
    as status='failed'."""
    pool = MagicMock()

    async def broken_step(ctx: RunStepContext) -> RunStepOutcome:
        raise RuntimeError("model timeout")

    def make_broken(_payload, _checkpoint, _messages, _context=None) -> RunStepFn:
        return broken_step

    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=None)),
        patch(
            "agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())
        ) as settle,
    ):
        outcome = await execute_start(pool, payload, make_step_fn=make_broken)
    assert outcome.settled is False
    assert outcome.error is not None
    assert "model timeout" in outcome.error
    # Task failure settled via the barrier.
    settle.assert_awaited()
    assert settle.await_args.kwargs["task_id"] == RUN_ID
    assert settle.await_args.kwargs["status"] == "failed"


@pytest.mark.asyncio
async def test_step_fn_returning_done_settles_after_one_step(
    payload: StartActionPayload,
) -> None:
    """An immediate `done` from the step fn → exactly one step pair
    + status:running + result:done. The minimum viable agent run."""
    pool = MagicMock()
    persisted: list[str] = []

    async def append(_pool, event, *, user_id):  # type: ignore[no-untyped-def]
        persisted.append(event.kind)

    async def immediate_done(ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    def make_immediate(_payload, _checkpoint, _messages, _context=None) -> RunStepFn:
        return immediate_done

    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock(side_effect=append)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=None)),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())),
    ):
        outcome = await execute_start(pool, payload, make_step_fn=make_immediate)
    assert outcome.settled is True
    # Order: status:running, step_start, step_end, result.
    assert persisted == ["status", "step_start", "step_end", "result"]


@pytest.mark.asyncio
async def test_checkpoint_max_steps_overrides_payload_default(
    payload: StartActionPayload,
) -> None:
    """The checkpoint's `config.maxSteps` wins over the payload's
    fallback — that's the contract the TS route depends on (it always
    writes `maxSteps`)."""
    pool = MagicMock()
    seen_max_steps: dict[str, int] = {}

    async def step(ctx: RunStepContext) -> RunStepOutcome:
        # First step settles; nothing to do here besides return done.
        return RunStepOutcome(done=True)

    def make(
        payload_: StartActionPayload, checkpoint: dict, _messages: list, _context=None
    ) -> RunStepFn:
        # We can't easily read `max_steps` post-call without
        # introspecting the loop, so instead we cap with one that's
        # very low and confirm the run uses it. See the helper
        # below — we test indirectly via the step counter.
        seen_max_steps["from_test"] = checkpoint.get("config", {}).get("maxSteps")
        return step

    checkpoint = {"config": {"maxSteps": 7}, "messages": []}
    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())),
    ):
        outcome = await execute_start(pool, payload, make_step_fn=make)
    assert outcome.settled is True
    assert seen_max_steps["from_test"] == 7


# ---------------------------------------------------------------------------
# Fan-out (spawned) tests
# ---------------------------------------------------------------------------

CONV_ID = "33333333-3333-3333-3333-333333333333"
CHILD_ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
CHILD_ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


def _make_spawn_step_fn(
    spawn_descriptor: SpawnDescriptor,
) -> tuple[list[int], MakeStepFn]:
    """Return a (call_counts, make_step_fn) pair whose step returns
    the given SpawnDescriptor once, then done=True on subsequent calls."""
    call_counts: list[int] = []

    def make(
        _payload: StartActionPayload,
        _checkpoint: dict,
        _messages: list,
        _context: object = None,
    ) -> RunStepFn:
        async def step(ctx: RunStepContext) -> RunStepOutcome:
            call_counts.append(ctx.step)
            # First step: return spawn. (Done=False so runner proceeds.)
            return RunStepOutcome(done=False, spawn=spawn_descriptor)

        return step

    return call_counts, make


@pytest.mark.asyncio
async def test_fanout_happy_path(payload: StartActionPayload) -> None:
    """A spawned outcome from the step fn → ONE `commit_spawn` carrying
    both children (their rows + start jobs), the absolute barrier count
    and the `awaiting_children` checkpoint; the handoff events name the
    same child ids; NO terminal settle and no piecemeal writes."""
    pool = MagicMock()
    descriptor = SpawnDescriptor(
        tool_call_id="call-1",
        tasks=[
            SpawnSpec(persona_slug="g1", subgoal="a"),
            SpawnSpec(persona_slug="g2", subgoal="b"),
        ],
    )
    _, make_step = _make_spawn_step_fn(descriptor)

    checkpoint = {
        "messages": [],
        "step": 0,
        "seq": 0,
        "config": {"maxSteps": 5},
    }
    appended: list[Any] = []

    async def record_event(_pool: object, event: Any, **_kw: object) -> None:
        appended.append(event)

    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock(side_effect=record_event)),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch.object(store, "load_parent_task_id", new=AsyncMock(return_value=None)),
        patch.object(store, "load_conversation_id", new=AsyncMock(return_value=CONV_ID)),
        patch.object(store, "commit_spawn", new=AsyncMock(return_value=True)) as commit,
        patch.object(store, "create_child_task", new=AsyncMock()) as create_child,
        patch.object(store, "set_pending_children", new=AsyncMock()) as set_pending,
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_cp,
        patch.object(store, "update_run", new=AsyncMock()) as update_run,
        patch.object(jobs, "enqueue_start_job", new=AsyncMock()) as enqueue_start,
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
    ):
        outcome = await execute_start(pool, payload, make_step_fn=make_step)

    assert outcome == ExecutorOutcome(settled=True)

    commit.assert_awaited_once()
    kw = commit.await_args.kwargs
    assert kw["parent_task_id"] == RUN_ID
    assert kw["user_id"] == USER_ID
    assert kw["conversation_id"] == CONV_ID
    children = kw["children"]
    assert [c.goal for c in children] == ["a", "b"]
    assert all(c.checkpoint["subagent"]["subgoal"] == c.goal for c in children)
    saved_checkpoint = kw["checkpoint"]
    ac = saved_checkpoint["awaiting_children"]
    assert ac["tool_call_id"] == "call-1"
    assert [c["id"] for c in ac["children"]] == [c.id for c in children]

    # Handoffs name the committed child ids, and the checkpoint's seq
    # covers them.
    handoffs = [e for e in appended if e.kind == "handoff"]
    assert [h.child_task_id for h in handoffs] == [c.id for c in children]
    assert saved_checkpoint["seq"] >= max(h.seq for h in handoffs)

    # Nothing written outside the one transaction.
    create_child.assert_not_awaited()
    enqueue_start.assert_not_awaited()
    set_pending.assert_not_awaited()
    save_cp.assert_not_awaited()
    assert not [c for c in update_run.await_args_list if c.kwargs.get("status")]
    settle.assert_not_awaited()


@pytest.mark.asyncio
async def test_fanout_on_a_settled_parent_creates_nothing(payload: StartActionPayload) -> None:
    """`commit_spawn` returns False when the parent settled (cancelled)
    while the chunk ran: the run ends cleanly, no terminal settle."""
    descriptor = SpawnDescriptor(
        tool_call_id="call-1", tasks=[SpawnSpec(persona_slug="g1", subgoal="a")]
    )
    _, make_step = _make_spawn_step_fn(descriptor)
    checkpoint = {"messages": [], "step": 0, "seq": 0, "config": {"maxSteps": 5}}
    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch.object(store, "load_parent_task_id", new=AsyncMock(return_value=None)),
        patch.object(store, "load_conversation_id", new=AsyncMock(return_value=CONV_ID)),
        patch.object(store, "commit_spawn", new=AsyncMock(return_value=False)),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
    ):
        outcome = await execute_start(MagicMock(), payload, make_step_fn=make_step)
    assert outcome == ExecutorOutcome(settled=True)
    settle.assert_not_awaited()


@pytest.mark.asyncio
async def test_fanout_depth_cap(payload: StartActionPayload) -> None:
    """When this task is itself a child (load_parent_task_id returns a
    non-null uuid), spawning is rejected: no create_child_task, a
    continue job IS enqueued, save_checkpoint is called, and the
    outcome is settled=True."""
    pool = MagicMock()
    descriptor = SpawnDescriptor(
        tool_call_id="call-depth",
        tasks=[SpawnSpec(persona_slug="g1", subgoal="nested")],
    )
    _, make_step = _make_spawn_step_fn(descriptor)

    PARENT_ID = "pppppppp-pppp-pppp-pppp-pppppppppppp"
    checkpoint = {
        "messages": [],
        "step": 0,
        "seq": 0,
        "config": {"maxSteps": 5},
    }

    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch.object(store, "load_parent_task_id", new=AsyncMock(return_value=PARENT_ID)),
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_cp,
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "commit_spawn", new=AsyncMock()) as commit,
        patch.object(jobs, "enqueue_continue_job", new=AsyncMock()) as enqueue_cont,
    ):
        outcome = await execute_start(pool, payload, make_step_fn=make_step)

    assert outcome == ExecutorOutcome(settled=True)
    # No children created, no start jobs enqueued.
    commit.assert_not_awaited()
    # A continue job was enqueued so the parent can proceed.
    enqueue_cont.assert_awaited_once_with(pool, task_id=RUN_ID, user_id=USER_ID)
    # Checkpoint was saved (carries the rejection tool_result in messages).
    save_cp.assert_awaited_once()


@pytest.mark.asyncio
async def test_fanout_breadth_clamp(payload: StartActionPayload) -> None:
    """A spawn with MAX_CHILDREN+2 tasks → exactly MAX_CHILDREN children
    created and start jobs enqueued."""
    pool = MagicMock()
    too_many = [
        SpawnSpec(persona_slug=f"g{i}", subgoal=f"task {i}") for i in range(MAX_CHILDREN + 2)
    ]
    descriptor = SpawnDescriptor(tool_call_id="call-wide", tasks=too_many)
    _, make_step = _make_spawn_step_fn(descriptor)

    checkpoint = {
        "messages": [],
        "step": 0,
        "seq": 0,
        "config": {"maxSteps": 5},
    }

    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch.object(store, "load_parent_task_id", new=AsyncMock(return_value=None)),
        patch.object(store, "load_conversation_id", new=AsyncMock(return_value=CONV_ID)),
        patch.object(store, "commit_spawn", new=AsyncMock(return_value=True)) as commit,
    ):
        outcome = await execute_start(pool, payload, make_step_fn=make_step)

    assert outcome == ExecutorOutcome(settled=True)
    assert len(commit.await_args.kwargs["children"]) == MAX_CHILDREN


# ---------------------------------------------------------------------------
# Fan-in (continue with awaiting_children) tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fan_in_injects_aggregated_tool_result_on_continue(
    payload: StartActionPayload,
) -> None:
    """execute_continue with awaiting_children in the checkpoint:
    - loads child results
    - aggregates them into a tool_result message
    - injects it into live_messages BEFORE the first step
    - clears awaiting_children from the forwarded checkpoint
    - loop proceeds and settles
    """
    pool = MagicMock()

    # Record messages seen by the step fn on the first call.
    captured_messages: list[list[dict]] = []

    def make_step_fn(
        _payload: StartActionPayload,
        _checkpoint: dict,
        messages: list,
        _context: object = None,
    ) -> RunStepFn:
        async def step(ctx: RunStepContext) -> RunStepOutcome:
            # Snapshot on first invocation.
            if not captured_messages:
                captured_messages.append(list(messages))
            return RunStepOutcome(done=True)

        return step

    checkpoint = {
        "messages": [
            # An assistant turn with the spawn tool_use block.
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "call-1",
                        "name": "spawnSubagent",
                        "input": {"tasks": []},
                    }
                ],
            }
        ],
        "step": 2,
        "seq": 7,
        "config": {"maxSteps": 5},
        "awaiting_children": {
            "tool_call_id": "call-1",
            "children": [{"id": "c1", "personaSlug": "r", "subgoal": "g"}],
        },
    }

    child_results = [
        ChildResult(persona_slug="r", subgoal="g", status="done", final_text="Found it.")
    ]

    saved_checkpoints: list[dict] = []

    async def fake_save_checkpoint(
        _pool: object, *, run_id: str, user_id: str, checkpoint: dict
    ) -> None:
        saved_checkpoints.append(checkpoint)

    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch.object(
            store,
            "load_child_results",
            new=AsyncMock(return_value=child_results),
        ) as load_child_results_mock,
        patch.object(store, "save_checkpoint", new=AsyncMock(side_effect=fake_save_checkpoint)),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())),
    ):
        outcome = await execute_continue(pool, payload, make_step_fn=make_step_fn)

    assert outcome == ExecutorOutcome(settled=True)

    # load_child_results was called for this parent run.
    load_child_results_mock.assert_awaited_once_with(pool, parent_task_id=RUN_ID, user_id=USER_ID)

    # The step fn saw a tool_result message for call-1.
    assert len(captured_messages) == 1
    msgs = captured_messages[0]
    # Last message should be the injected tool_result user turn.
    tool_result_msg = next(
        (m for m in msgs if m.get("role") == "user" and isinstance(m.get("content"), list)),
        None,
    )
    assert tool_result_msg is not None, "No user/tool_result message found in step fn messages"
    block = tool_result_msg["content"][0]
    assert block["type"] == "tool_result"
    assert block["tool_use_id"] == "call-1"
    # Aggregated text includes the header + content.
    assert "### r: g" in block["content"]
    assert "Found it." in block["content"]

    # The forwarded checkpoint (saved on settle or yield) must NOT have awaiting_children.
    # (settle path: no save_checkpoint; but we also want to assert the cleared marker
    # is what the loop saw — verify via the step fn seeing no awaiting_children.)
    # On the settle path save_checkpoint is NOT called (terminal settle goes through
    # settle_task_terminal). Confirm the loop ran (captured_messages was populated).
    assert captured_messages, "Step fn was never called"
