"""Join-barrier ordering + fan-in status.

- `commit_spawn` writes the parent's barrier state (absolute count,
  `awaiting_children` checkpoint, `paused`) and the children + their
  start jobs in ONE transaction, parent first — no child can run, let
  alone settle, before the parent is ready (finding: children used to
  be committed before the counter was set).
- The fan-in `continue` flips the parent `paused → running` (only
  once every child settled) before resuming, so a later reclaim is not
  mistaken for a task waiting on the user.
- A reclaimed `continue` on a task stranded `paused` by the old fan-in
  (no children pending, no fan-in marker, no pending input) is
  recovered instead of skipped.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import db, executor, jobs, poller, store
from agent_py.executor import ExecutorOutcome, StartActionPayload, execute_continue
from agent_py.runner import RunStepContext, RunStepFn, RunStepOutcome
from agent_py.store import ChildResult, ChildSpawn

from .test_job_lease import _job, _live_settings, _state
from .test_pipeline_correctness import _norm, _pool, _RecordingConn

RUN_ID = str(uuid.uuid4())
USER_ID = str(uuid.uuid4())
CONV_ID = str(uuid.uuid4())


# --- commit_spawn -----------------------------------------------------------


def _children(n: int) -> list[ChildSpawn]:
    return [
        ChildSpawn(
            id=str(uuid.uuid4()), goal=f"g{i}", checkpoint={"subagent": {"subgoal": f"g{i}"}}
        )
        for i in range(n)
    ]


@pytest.mark.asyncio
async def test_commit_spawn_is_one_transaction_parent_first() -> None:
    conn = _RecordingConn(fetchrow=[{"id": RUN_ID}])
    children = _children(2)
    checkpoint = {"seq": 9, "awaiting_children": {"tool_call_id": "c"}}
    ok = await store.commit_spawn(
        _pool(conn),
        parent_task_id=RUN_ID,
        user_id=USER_ID,
        conversation_id=CONV_ID,
        children=children,
        checkpoint=checkpoint,
    )
    assert ok is True
    kinds = [k for k, _ in conn.calls]
    # Everything inside one transaction: the lock, then the parent first.
    assert kinds[0] == "txn_begin" and kinds[-1] == "txn_end"
    assert kinds[1:3] == ["execute", "fetchrow"]
    assert "private.lock_task_scope" in conn.calls[1][1][0]
    parent_sql = _norm(conn.calls[2][1][0])
    assert "SET status = 'paused'" in parent_sql
    assert "pending_children = $3" in parent_sql
    assert "status NOT IN ('done', 'failed', 'cancelled')" in parent_sql
    assert conn.calls[2][1][3] == 2  # absolute count = len(children)
    assert conn.calls[1][1][-1] is True, "lock outside the transaction"
    executes = [args for k, args in conn.calls if k == "execute"][1:]
    assert len(executes) == 4  # child row + start job, per child
    assert all(args[-1] is True for args in executes), "write outside the transaction"
    assert "INSERT INTO public.tasks" in executes[0][0]
    assert executes[0][1] == uuid.UUID(children[0].id)
    assert "INSERT INTO public.task_jobs" in executes[1][0]
    assert "'start'" in executes[1][0]
    assert executes[1][1] == uuid.UUID(children[0].id)


@pytest.mark.asyncio
async def test_commit_spawn_on_a_settled_parent_creates_nothing() -> None:
    conn = _RecordingConn(fetchrow=[None])
    ok = await store.commit_spawn(
        _pool(conn),
        parent_task_id=RUN_ID,
        user_id=USER_ID,
        conversation_id=CONV_ID,
        children=_children(2),
        checkpoint={},
    )
    assert ok is False
    executed = [args[0] for k, args in conn.calls if k == "execute"]
    assert len(executed) == 1 and "private.lock_task_scope" in executed[0]


@pytest.mark.asyncio
async def test_claim_paused_for_fan_in_sql() -> None:
    conn = _RecordingConn(fetchrow=[{"id": RUN_ID}])
    assert await store.claim_paused_for_fan_in(_pool(conn), run_id=RUN_ID, user_id=USER_ID)
    sql = _norm(conn.calls[0][1][0])
    assert "SET status = 'running'" in sql
    assert "status = 'paused'" in sql
    assert "pending_children <= 0" in sql
    assert "user_id = $2" in sql


# --- fan-in flips the parent back to running --------------------------------


def _fan_in_checkpoint() -> dict[str, Any]:
    return {
        "messages": [
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "call-1", "name": "spawnSubagent", "input": {}}
                ],
            }
        ],
        "step": 2,
        "seq": 7,
        "config": {"maxSteps": 5},
        "awaiting_children": {"tool_call_id": "call-1", "children": []},
    }


def _done_step(seen: list[int]) -> Any:
    def make(*_a: Any) -> RunStepFn:
        async def step(ctx: RunStepContext) -> RunStepOutcome:
            seen.append(ctx.step)
            return RunStepOutcome(done=True)

        return step

    return make


def _fan_in_patches(claim: AsyncMock, status: str | None = "running") -> Any:
    from contextlib import ExitStack

    stack = ExitStack()
    for name, mock in {
        "set_task_handler": AsyncMock(),
        "append_event": AsyncMock(),
        "is_run_cancelled": AsyncMock(return_value=False),
        "update_run": AsyncMock(),
        "save_checkpoint": AsyncMock(),
        "max_event_seq": AsyncMock(return_value=7),
        "load_run_events": AsyncMock(return_value=[]),
        "load_checkpoint": AsyncMock(return_value=_fan_in_checkpoint()),
        "load_child_results": AsyncMock(
            return_value=[ChildResult(persona_slug="r", subgoal="g", status="done", final_text="x")]
        ),
        "claim_paused_for_fan_in": claim,
        "load_owned_task_status": AsyncMock(return_value=status),
    }.items():
        stack.enter_context(patch.object(store, name, new=mock))
    settle = stack.enter_context(
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock()))
    )
    return stack, settle


@pytest.mark.asyncio
async def test_fan_in_flips_the_parent_running_before_resuming() -> None:
    order: list[str] = []
    claim = AsyncMock(side_effect=lambda *a, **k: order.append("claim") or True)
    seen: list[int] = []
    stack, settle = _fan_in_patches(claim)
    with stack:
        store.load_child_results.side_effect = lambda *a, **k: order.append("children") or []  # type: ignore[attr-defined]
        outcome = await execute_continue(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step(seen),
        )
    assert outcome == ExecutorOutcome(settled=True)
    claim.assert_awaited_once()
    assert order == ["claim", "children"]
    assert seen, "the run resumed"
    assert settle.await_args.kwargs["status"] == "done"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["paused", "cancelled", "done", None])
async def test_fan_in_not_ready_is_a_no_op(status: str | None) -> None:
    """Children still pending (stray continue) or the run settled: the
    flip fails and the task isn't `running` — nothing runs."""
    seen: list[int] = []
    stack, settle = _fan_in_patches(AsyncMock(return_value=False), status=status)
    with stack:
        outcome = await execute_continue(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step(seen),
        )
    assert outcome == ExecutorOutcome(settled=True)
    assert seen == []
    settle.assert_not_awaited()


@pytest.mark.asyncio
async def test_reclaimed_fan_in_already_flipped_by_the_dead_attempt_resumes() -> None:
    seen: list[int] = []
    stack, _ = _fan_in_patches(AsyncMock(return_value=False), status="running")
    with stack:
        outcome = await execute_continue(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step(seen),
            reclaimed=True,
        )
    assert outcome == ExecutorOutcome(settled=True)
    assert seen


# --- recovering a run stranded `paused` --------------------------------------


def test_reclaim_decision_recovers_a_paused_continue_with_nothing_pending() -> None:
    state = _state(task_status="paused", pending_children=0, awaiting_children=False)
    assert poller.reclaim_decision("continue", state)[0] == "recover"
    # Still skipped while children are pending; fan-in still runs.
    pending = _state(task_status="paused", pending_children=2, awaiting_children=True)
    assert poller.reclaim_decision("continue", pending) == ("skip", "task_paused")
    fan_in = _state(task_status="paused", pending_children=0, awaiting_children=True)
    assert poller.reclaim_decision("continue", fan_in) == ("run", "fan_in_resume")
    # A start on a paused task is still skipped.
    assert poller.reclaim_decision("start", state) == ("skip", "task_paused")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("checkpoint", "expected_claim"),
    [
        # Mid-run checkpoint, last turn answered → stranded, recover.
        (
            {
                "messages": [
                    {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
                ]
            },
            True,
        ),
        # Last turn has an unanswered call → waiting on the user.
        (
            {
                "messages": [
                    {
                        "role": "assistant",
                        "content": [{"type": "tool_use", "id": "t1", "name": "x", "input": {}}],
                    }
                ]
            },
            False,
        ),
        # The barrier owns a parent with a fan-in marker.
        ({"messages": [], "awaiting_children": {"tool_call_id": "c"}}, False),
        (None, False),
    ],
)
async def test_recover_stranded_paused_run(
    checkpoint: dict[str, Any] | None, expected_claim: bool
) -> None:
    claim = AsyncMock(return_value=True)
    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch.object(store, "claim_paused_for_fan_in", new=claim),
    ):
        recovered = await executor.recover_stranded_paused_run(
            MagicMock(), task_id=RUN_ID, user_id=USER_ID
        )
    assert recovered is expected_claim
    assert claim.await_count == (1 if expected_claim else 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("recovered", [True, False])
async def test_poller_recover_dispatch(recovered: bool) -> None:
    job = _job(action="continue", reclaimed=True)
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "mark_job_done", new=AsyncMock()) as mark_done,
            patch.object(jobs, "mark_job_failed", new=AsyncMock()),
            patch.object(jobs, "reap_expired_jobs", new=AsyncMock(return_value=[])),
            patch.object(jobs, "extend_lease", new=AsyncMock(return_value=True)),
            patch.object(
                jobs,
                "load_job_task_state",
                new=AsyncMock(
                    return_value=_state(
                        task_status="paused", pending_children=0, awaiting_children=False
                    )
                ),
            ),
            patch.object(store, "load_owned_task_status", new=AsyncMock(return_value="paused")),
            patch.object(
                poller.feature_flag, "python_executes_for_user", new=AsyncMock(return_value=True)
            ),
            patch.object(
                executor, "recover_stranded_paused_run", new=AsyncMock(return_value=recovered)
            ),
            patch.object(
                executor,
                "execute_continue",
                new=AsyncMock(return_value=ExecutorOutcome(settled=True)),
            ) as ex_continue,
        ):
            await poller._tick(_live_settings())
        mark_done.assert_awaited_once()
        if recovered:
            ex_continue.assert_awaited_once()
            assert ex_continue.await_args.kwargs.get("reclaimed") is True
        else:
            ex_continue.assert_not_awaited()
    finally:
        db._pool = None
