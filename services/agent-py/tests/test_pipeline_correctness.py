"""Regression tests for the agent-py pipeline correctness fixes.

Each section pins one bug that shipped with the mocked-store test
suite still green:

  1. `set_task_handler` wrote a column (`tasks.metadata`) no migration
     created → every run failed. Now migration 0030 adds it and the
     stamp is non-fatal.
  2. `release_job_to_queue` left `scheduled_at` unchanged → the poller
     hot-looped on a released job and head-of-line blocked the queue;
     claim ignored `max_attempts`.
  3. Seq collisions: `start` seeded at 0 under the route's seq=1
     `status: queued`; suspend saved the checkpoint before emitting the
     approval request + `status: paused`. Both silently dropped events
     via `ON CONFLICT DO NOTHING`.
  4. Nothing passed `final_text` to the terminal `result`, so subagent
     fan-in always saw an empty result.
  5. A duplicate respond re-executed the approved tool.
  6. Unscoped (`user_id`-less) queries + `SET LOCAL` outside a
     transaction; forged jobs pointing at another user's task.
  7. `config.maxSteps` was unbounded.

SQL-level assertions run against a recording fake connection (no live
Postgres in CI); executor-level ones drive the real executor with a
list sink and only the DB edges patched.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import barrier, db, executor, feature_flag, jobs, poller, store
from agent_py.events import ApprovalEvent, ResultEvent, StatusEvent, TaskEvent, TokenEvent
from agent_py.jobs import ClaimedJob
from agent_py.runner import (
    PendingInputDescriptor,
    RunStepContext,
    RunStepFn,
    RunStepOutcome,
    run_agent_loop,
)
from agent_py.settings import Settings
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

RUN_ID = "22222222-2222-2222-2222-222222222222"
USER_ID = "33333333-3333-3333-3333-333333333333"
OTHER_USER = "44444444-4444-4444-4444-444444444444"
REPO_ROOT = Path(__file__).resolve().parents[3]


# --- helpers ----------------------------------------------------------------


class _RecordingConn:
    """Fake asyncpg connection that records every call (and transaction
    enter/exit) in order, returning canned values per method."""

    def __init__(
        self,
        *,
        fetchrow: list[Any] | None = None,
        fetch: Any = None,
        execute: str = "UPDATE 1",
    ) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self._fetchrow = list(fetchrow or [])
        self._fetch = fetch if fetch is not None else []
        self._execute = execute
        self.in_txn = False

    async def fetchrow(self, sql: str, *args: Any) -> Any:
        self.calls.append(("fetchrow", (sql, *args)))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetch(self, sql: str, *args: Any) -> Any:
        self.calls.append(("fetch", (sql, *args, self.in_txn)))
        return self._fetch

    async def execute(self, sql: str, *args: Any) -> str:
        self.calls.append(("execute", (sql, *args, self.in_txn)))
        return self._execute

    def transaction(self) -> Any:
        conn = self

        class _Txn:
            async def __aenter__(self) -> None:
                conn.in_txn = True
                conn.calls.append(("txn_begin", ()))

            async def __aexit__(self, *_exc: Any) -> None:
                conn.in_txn = False
                conn.calls.append(("txn_end", ()))

        return _Txn()


def _pool(conn: _RecordingConn) -> MagicMock:
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=None)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


def _norm(sql: str) -> str:
    return " ".join(sql.split())


def _list_sink() -> tuple[list[TaskEvent], Any]:
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    return collected, sink


# --- 1. tasks.metadata ------------------------------------------------------


def test_a_migration_creates_tasks_metadata() -> None:
    """`set_task_handler` writes `tasks.metadata`; some migration must
    create it."""
    migrations = REPO_ROOT / "supabase" / "migrations"
    sql = "\n".join(p.read_text() for p in sorted(migrations.glob("*.sql"))).lower()
    assert "add column if not exists metadata jsonb" in sql
    assert "metadata" in store._SET_HANDLER_SQL


@pytest.mark.asyncio
async def test_set_task_handler_failure_does_not_fail_the_run() -> None:
    collected, sink = _list_sink()

    async def step(_ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value={})),
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=0)),
        patch.object(
            store,
            "set_task_handler",
            new=AsyncMock(side_effect=RuntimeError('column "metadata" does not exist')),
        ),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor._make_db_sink", return_value=sink),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
    ):
        outcome = await executor.execute_start(
            MagicMock(),
            executor.StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=lambda *_a: step,
        )

    assert outcome.settled is True
    assert settle.await_args.kwargs["status"] == "done"
    results = [e for e in collected if isinstance(e, ResultEvent)]
    assert [r.status for r in results] == ["done"]


# --- 2. job queue -----------------------------------------------------------


def test_claim_skips_jobs_past_max_attempts() -> None:
    assert "attempts < max_attempts" in _norm(jobs._CLAIM_SQL)


@pytest.mark.asyncio
async def test_release_backs_off_scheduled_at_and_undoes_attempt_bump() -> None:
    conn = _RecordingConn(execute="UPDATE 1")
    job_id = str(uuid.uuid4())
    assert await jobs.release_job_to_queue(_pool(conn), job_id) is True
    (kind, (sql, *args)) = conn.calls[0]
    assert kind == "execute"
    flat = _norm(sql)
    # The claim orders by scheduled_at — a release must move it forward
    # or the same row is re-claimed next tick (hot loop / HOL block).
    assert "scheduled_at = now() + LEAST(" in flat
    assert "interval '5 minutes'" in flat
    assert "GREATEST(interval '5 seconds', (now() - created_at) / 2)" in flat
    # A release isn't a failed attempt — don't burn the retry budget.
    assert "attempts = GREATEST(attempts - 1, 0)" in flat
    assert "status = 'running'" in flat
    assert args[0] == uuid.UUID(job_id)


# --- 3. seq collisions ------------------------------------------------------


@pytest.mark.asyncio
async def test_max_event_seq_is_user_scoped() -> None:
    conn = _RecordingConn(fetchrow=[{"max_seq": 7}])
    assert await store.max_event_seq(_pool(conn), run_id=RUN_ID, user_id=USER_ID) == 7
    _, (sql, *args) = conn.calls[0]
    assert "MAX(seq)" in sql and "user_id = $2" in sql
    assert args[:2] == [uuid.UUID(RUN_ID), uuid.UUID(USER_ID)]


@pytest.mark.asyncio
async def test_start_does_not_reuse_the_routes_queued_seq() -> None:
    """The TS route writes `status: queued` at seq=1 and a checkpoint
    with seq=1. `start` used to seed at 0, so its first event (seq=1)
    collided and was dropped."""
    collected, sink = _list_sink()

    async def step(_ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(return_value={"messages": [], "step": 0, "seq": 1, "config": {}}),
        ),
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=1)),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor._make_db_sink", return_value=sink),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()),
    ):
        await executor.execute_start(
            MagicMock(),
            executor.StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=lambda *_a: step,
        )

    seqs = [e.seq for e in collected]
    assert seqs[0] == 2
    assert seqs == list(range(2, 2 + len(seqs)))


@pytest.mark.asyncio
async def test_resume_seeds_past_events_newer_than_the_checkpoint() -> None:
    """A checkpoint whose seq lags the event log (crash after emit,
    before save) must not make the resumed chunk reuse those seqs."""
    collected, sink = _list_sink()

    async def step(_ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(return_value={"messages": [], "step": 2, "seq": 5, "config": {}}),
        ),
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=9)),
        patch.object(store, "load_run_events", new=AsyncMock(return_value=[])),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor._make_db_sink", return_value=sink),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()),
    ):
        await executor.execute_continue(
            MagicMock(),
            executor.StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=lambda *_a: step,
        )

    assert min(e.seq for e in collected) == 10


def _suspending_make_step(tool_call_id: str, tool: str) -> executor.MakeStepFn:
    def make(_p: Any, _c: Any, messages: list[Any], _ctx: Any = None) -> RunStepFn:
        async def step(_ctx: RunStepContext) -> RunStepOutcome:
            messages.append(
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": tool_call_id, "name": tool, "input": {}}
                    ],
                }
            )
            return RunStepOutcome(
                done=False,
                pending_input=PendingInputDescriptor(tool_call_id=tool_call_id, tool=tool, args={}),
            )

        return step

    return make


@pytest.mark.asyncio
async def test_suspend_checkpoint_seq_covers_approval_and_paused() -> None:
    collected, sink = _list_sink()
    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value={
                    "messages": [{"role": "user", "content": "go"}],
                    "seq": 1,
                    "config": {"requireApprovalFor": ["danger"]},
                }
            ),
        ),
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=1)),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_checkpoint,
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        await executor.execute_start(
            MagicMock(),
            executor.StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_suspending_make_step("tu_1", "danger"),
        )

    saved_seq = save_checkpoint.await_args.kwargs["checkpoint"]["seq"]
    paused = [e for e in collected if isinstance(e, StatusEvent) and e.status == "paused"]
    assert len(paused) == 1
    assert saved_seq == paused[0].seq == max(e.seq for e in collected)


# --- 4. finalText for fan-in ------------------------------------------------


@pytest.mark.asyncio
async def test_runner_passes_final_text_to_result() -> None:
    collected, sink = _list_sink()
    from agent_py.emitter import RunEmitter

    emitter = RunEmitter(run_id=RUN_ID, sink=sink)

    async def step(_ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    async def no() -> bool:
        return False

    async def final_text() -> str | None:
        return "the answer"

    await run_agent_loop(
        emitter=emitter, max_steps=3, run_step=step, is_cancelled=no, final_text=final_text
    )
    result = next(e for e in collected if isinstance(e, ResultEvent))
    assert result.final_text == "the answer"


@pytest.mark.asyncio
async def test_start_result_carries_accumulated_text_for_fan_in() -> None:
    collected, sink = _list_sink()

    async def step(ctx: RunStepContext) -> RunStepOutcome:
        await ctx.emitter.token("Found ")
        await ctx.emitter.token("thinking…", channel="reasoning")
        await ctx.emitter.token("it.")
        return RunStepOutcome(done=True)

    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value={})),
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=0)),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor._make_db_sink", return_value=sink),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()),
    ):
        await executor.execute_start(
            MagicMock(),
            executor.StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=lambda *_a: step,
        )

    result = next(e for e in collected if isinstance(e, ResultEvent))
    assert result.final_text == "Found it."


@pytest.mark.asyncio
async def test_continue_result_text_spans_earlier_chunks() -> None:
    """A run that settles in a `continue` chunk reports the whole run's
    text (from the event log), not just this chunk's slice."""
    collected, sink = _list_sink()
    prior = [
        TokenEvent(run_id=RUN_ID, seq=3, step=1, created_at="t", text="Part one. "),
        TokenEvent(run_id=RUN_ID, seq=9, step=2, created_at="t", text="Part two."),
    ]

    async def step(_ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(return_value={"messages": [], "step": 2, "seq": 9, "config": {}}),
        ),
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=9)),
        patch.object(store, "load_run_events", new=AsyncMock(return_value=prior)) as load,
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor._make_db_sink", return_value=sink),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()),
    ):
        await executor.execute_continue(
            MagicMock(),
            executor.StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=lambda *_a: step,
        )

    result = next(e for e in collected if isinstance(e, ResultEvent))
    assert result.final_text == "Part one. Part two."
    # finalize + final_text share one event-log read.
    load.assert_awaited_once()


# --- 5. duplicate respond ---------------------------------------------------


def _paused_checkpoint(*, answered: bool) -> dict[str, Any]:
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": "go"},
        {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "tu_1", "name": "danger", "input": {}}],
        },
    ]
    if answered:
        messages.append(
            {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "tu_1", "content": "ran"}],
            }
        )
    return {"messages": messages, "step": 1, "seq": 8, "config": {"requireApprovalFor": ["danger"]}}


def _recording_tool() -> tuple[list[dict[str, Any]], dict[str, ToolDescriptor]]:
    calls: list[dict[str, Any]] = []

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        calls.append(args)
        return ToolInvocationResult(text="ran", summary="ran")

    return calls, {
        "danger": ToolDescriptor(
            name="danger", description="", input_schema={"type": "object"}, execute=execute
        )
    }


def _respond_payload() -> executor.RespondActionPayload:
    return executor.RespondActionPayload(
        run_id=RUN_ID, user_id=USER_ID, request_id="tu_1", approved=True
    )


@pytest.mark.asyncio
async def test_respond_that_loses_the_paused_claim_is_a_noop() -> None:
    tool_calls, registry = _recording_tool()
    collected, sink = _list_sink()
    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(return_value=_paused_checkpoint(answered=False)),
        ),
        patch.object(store, "claim_paused_for_respond", new=AsyncMock(return_value=False)),
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_checkpoint,
        patch("agent_py.executor.default_tool_registry", return_value=registry),
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        outcome = await executor.execute_respond(MagicMock(), _respond_payload())

    assert outcome.settled is True
    assert tool_calls == []
    assert collected == []
    save_checkpoint.assert_not_called()


@pytest.mark.asyncio
async def test_respond_for_an_already_answered_call_is_a_noop() -> None:
    tool_calls, registry = _recording_tool()
    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(return_value=_paused_checkpoint(answered=True)),
        ),
        patch.object(store, "claim_paused_for_respond", new=AsyncMock(return_value=True)) as claim,
        patch("agent_py.executor.default_tool_registry", return_value=registry),
    ):
        outcome = await executor.execute_respond(MagicMock(), _respond_payload())

    assert outcome.settled is True
    assert tool_calls == []
    claim.assert_not_called()


@pytest.mark.asyncio
async def test_respond_claims_then_executes_once() -> None:
    tool_calls, registry = _recording_tool()
    collected, sink = _list_sink()

    async def step(_ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(return_value=_paused_checkpoint(answered=False)),
        ),
        patch.object(store, "claim_paused_for_respond", new=AsyncMock(return_value=True)) as claim,
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=8)),
        patch.object(store, "load_run_events", new=AsyncMock(return_value=[])),
        patch.object(store, "save_checkpoint", new=AsyncMock()),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor.default_tool_registry", return_value=registry),
        patch("agent_py.executor._make_db_sink", return_value=sink),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()),
    ):
        outcome = await executor.execute_respond(
            MagicMock(), _respond_payload(), make_step_fn=lambda *_a: step
        )

    assert outcome.settled is True
    claim.assert_awaited_once()
    assert tool_calls == [{}]
    assert collected[0].seq == 9
    assert isinstance(collected[0], ApprovalEvent)


@pytest.mark.asyncio
async def test_claim_paused_for_respond_sql_is_atomic_and_scoped() -> None:
    conn = _RecordingConn(fetchrow=[None])
    assert (
        await store.claim_paused_for_respond(_pool(conn), run_id=RUN_ID, user_id=USER_ID) is False
    )
    _, (sql, *args) = conn.calls[0]
    flat = _norm(sql)
    assert "SET status = 'running'" in flat
    assert "WHERE id = $1 AND user_id = $2 AND status = 'paused'" in flat
    assert "RETURNING id" in flat
    assert args == [uuid.UUID(RUN_ID), uuid.UUID(USER_ID)]


def test_find_pending_tool_call_skips_answered_calls() -> None:
    answered = executor._messages_from(_paused_checkpoint(answered=True))
    assert executor._find_pending_tool_call(answered, "tu_1") is None
    pending = executor._messages_from(_paused_checkpoint(answered=False))
    found = executor._find_pending_tool_call(pending, "tu_1")
    assert found is not None and found["tool_name"] == "danger"


# --- 6. user scoping + ownership -------------------------------------------


@pytest.mark.asyncio
async def test_settle_task_terminal_is_user_scoped() -> None:
    parent = uuid.uuid4()
    conn = _RecordingConn(
        fetchrow=[{"parent_task_id": parent}, {"pending_children": 1, "status": "paused"}]
    )
    await barrier.settle_task_terminal(_pool(conn), task_id=RUN_ID, user_id=USER_ID, status="done")
    (_, (t_sql, *t_args)), (_, (d_sql, *d_args)) = conn.calls[1:3]
    assert "user_id = $3" in t_sql and t_args == [uuid.UUID(RUN_ID), "done", uuid.UUID(USER_ID)]
    assert "user_id = $2" in d_sql and d_args == [parent, uuid.UUID(USER_ID)]


@pytest.mark.asyncio
async def test_set_pending_children_is_user_scoped() -> None:
    conn = _RecordingConn()
    await store.set_pending_children(_pool(conn), task_id=RUN_ID, user_id=USER_ID, n=2)
    _, (sql, *args) = conn.calls[0]
    assert "WHERE id = $1 AND user_id = $3" in sql
    assert args[:3] == [uuid.UUID(RUN_ID), 2, uuid.UUID(USER_ID)]


@pytest.mark.asyncio
async def test_load_child_results_is_user_scoped() -> None:
    conn = _RecordingConn(fetch=[])
    await store.load_child_results(_pool(conn), parent_task_id=RUN_ID, user_id=USER_ID)
    _, (sql, *args) = conn.calls[0]
    flat = _norm(sql)
    assert "t.parent_task_id = $1 AND t.user_id = $2" in flat
    assert "e.user_id = t.user_id" in flat
    assert args[:2] == [uuid.UUID(RUN_ID), uuid.UUID(USER_ID)]


@pytest.mark.asyncio
async def test_load_run_events_sets_rls_context_inside_a_transaction() -> None:
    """`SET LOCAL` outside a transaction is a no-op (with a warning), so
    RLS never applied. Every statement must run inside the txn."""
    conn = _RecordingConn(fetch=[])
    await store.load_run_events(_pool(conn), run_id=RUN_ID, user_id=USER_ID)
    kinds = [c[0] for c in conn.calls]
    assert kinds[0] == "txn_begin" and kinds[-1] == "txn_end"
    for kind, args in conn.calls:
        if kind in ("execute", "fetch"):
            assert args[-1] is True, f"{kind} ran outside the transaction"
    fetch_sql = next(args[0] for kind, args in conn.calls if kind == "fetch")
    assert "user_id = $2" in fetch_sql


@pytest.mark.asyncio
async def test_load_owned_task_status_sql() -> None:
    conn = _RecordingConn(fetchrow=[None])
    status = await store.load_owned_task_status(_pool(conn), task_id=RUN_ID, user_id=USER_ID)
    assert status is None
    _, (sql, *args) = conn.calls[0]
    assert "id = $1 AND user_id = $2" in sql
    assert args == [uuid.UUID(RUN_ID), uuid.UUID(USER_ID)]


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["start", "continue", "respond"])
async def test_poller_rejects_job_for_a_task_the_user_does_not_own(action: str) -> None:
    job = ClaimedJob(
        id=str(uuid.uuid4()),
        task_id=RUN_ID,
        user_id=OTHER_USER,
        action=action,
        payload={"requestId": "tu_1"},
        attempts=1,
        max_attempts=3,
    )
    settings = Settings(
        SUPABASE_DB_URL="postgresql://localhost/fake",
        WORKER_DRY_RUN=False,
        POLL_INTERVAL_SECONDS=0.001,
    )
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "mark_job_failed", new=AsyncMock()) as mark_failed,
            patch.object(jobs, "mark_job_done", new=AsyncMock()) as mark_done,
            patch.object(
                feature_flag, "python_executes_for_user", new=AsyncMock(return_value=True)
            ),
            patch.object(
                store, "load_owned_task_status", new=AsyncMock(return_value=None)
            ) as owned,
            patch.object(executor, "execute_start", new=AsyncMock()) as ex_start,
            patch.object(executor, "execute_continue", new=AsyncMock()) as ex_continue,
            patch.object(executor, "execute_respond", new=AsyncMock()) as ex_respond,
        ):
            await poller._tick(settings)
        owned.assert_awaited_once_with(db._pool, task_id=RUN_ID, user_id=OTHER_USER)
        mark_failed.assert_awaited_once()
        mark_done.assert_not_called()
        ex_start.assert_not_called()
        ex_continue.assert_not_called()
        ex_respond.assert_not_called()
    finally:
        db._pool = None


# --- 7. maxSteps clamp ------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(10, 10), (50, 50), (51, 50), (10_000, 50), (0, 25), (-3, 25), (True, 25), ("9", 25)],
)
def test_max_steps_is_clamped(raw: object, expected: int) -> None:
    assert executor._max_steps_from({"config": {"maxSteps": raw}}, 25) == expected


def test_max_steps_fallback_is_clamped_too() -> None:
    assert executor._max_steps_from({}, 500) == executor.MAX_STEPS_CAP
