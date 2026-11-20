"""Recovery when a job's lease is lost or its worker died mid-run.

Follow-ups to the lease work in `test_job_lease.py`:

  1. Lost lease → the run stops cooperatively: no further events, no
     tool execution, no checkpoint / task / job settle. A transient
     heartbeat error does NOT stop it unless the lease would have
     expired by then.
  2. Reclaimed `start` → resumes from a checkpoint the dead attempt
     saved, else restarts behind a `status: running, restarted` marker
     that consumers use to drop the dead attempt's partial output.
  3. Reclaimed `respond` whose worker died after paused → running →
     re-applies the answer from the job payload when it wasn't
     persisted, else continues from the checkpoint.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import executor, jobs, lease, poller, store, verify
from agent_py.emitter import RunEmitter
from agent_py.events import (
    ApprovalEvent,
    ResultEvent,
    StatusEvent,
    StepStartEvent,
    TaskEvent,
    TokenEvent,
    ToolInputEvent,
    ToolOutputEvent,
    event_to_row_payload,
)
from agent_py.executor import ExecutorOutcome, StartActionPayload
from agent_py.lease import JobLease, LeaseLostError
from agent_py.providers.anthropic_provider import AnthropicStepConfig, make_anthropic_step_fn
from agent_py.runner import RunStepContext, RunStepFn, RunStepOutcome
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

from .test_anthropic_provider import _FakeClient
from .test_job_lease import JOB_ID, RUN_ID, USER_ID, _job, _live_settings, _state

# --- helpers ----------------------------------------------------------------


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def _list_sink() -> tuple[list[TaskEvent], Any]:
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    return collected, sink


def _tool(name: str, calls: list[str], *, on_call: Any = None) -> ToolDescriptor:
    async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
        calls.append(name)
        if on_call is not None:
            on_call()
        return ToolInvocationResult(text=f"{name} ran", summary="ok")

    return ToolDescriptor(
        name=name, description="", input_schema={"type": "object"}, execute=execute
    )


def _tool_use(tool_id: str, name: str) -> dict[str, Any]:
    return {"type": "tool_use", "id": tool_id, "name": name, "input": {}}


def _done_step_fn(seen_messages: list[list[dict[str, Any]]] | None = None) -> Any:
    def make(_p: Any, _c: Any, messages: list[dict[str, Any]], _ctx: Any = None) -> RunStepFn:
        if seen_messages is not None:
            seen_messages.append(messages)

        async def step(ctx: RunStepContext) -> RunStepOutcome:
            await ctx.emitter.token("answer")
            return RunStepOutcome(done=True)

        return step

    return make


@contextmanager
def _db(checkpoint: dict[str, Any] | None, *, max_seq: int, sink: Any) -> Iterator[None]:
    """Patch the DB edges every executor path touches."""
    with ExitStack() as stack:
        for p in (
            patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
            patch.object(store, "max_event_seq", new=AsyncMock(return_value=max_seq)),
            patch.object(store, "set_task_handler", new=AsyncMock()),
            patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
            patch.object(store, "load_run_events", new=AsyncMock(return_value=[])),
            patch("agent_py.executor._make_db_sink", return_value=sink),
        ):
            stack.enter_context(p)
        yield


# --- 1. lease guard ---------------------------------------------------------


def test_job_lease_expires_locally_and_latches_lost() -> None:
    clock = _Clock()
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=10, acquired_at=0.0, clock=clock)
    clock.t = 6
    job_lease.check()  # still valid
    job_lease.renewed(sent_at=5)  # → valid until 15
    clock.t = 14
    job_lease.check()
    clock.t = 15
    with pytest.raises(LeaseLostError):
        job_lease.check()
    # Latched: a later successful extend doesn't revive the run.
    job_lease.renewed(sent_at=15)
    clock.t = 16
    with pytest.raises(LeaseLostError):
        job_lease.check()
    assert job_lease.lost_reason == "lease_expired"


def test_check_current_is_a_noop_without_a_bound_lease() -> None:
    lease.check_current()
    lost = JobLease(job_id=JOB_ID, lease_seconds=10)
    lost.mark_lost("claim_taken_over")
    with lease.bound(lost), pytest.raises(LeaseLostError):
        lease.check_current()
    lease.check_current()  # unbound again on exit


@pytest.mark.asyncio
async def test_heartbeat_marks_the_lease_lost_when_the_claim_was_taken_over() -> None:
    clock = _Clock()
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=3, acquired_at=0.0, clock=clock)

    async def fake_sleep(seconds: float) -> None:
        clock.t += seconds

    with patch.object(jobs, "extend_lease", new=AsyncMock(return_value=False)) as extend:
        await poller._heartbeat(
            MagicMock(),
            _job(),
            _live_settings(JOB_LEASE_SECONDS=3),
            job_lease,
            sleep=fake_sleep,
            clock=clock,
        )
    assert extend.await_count == 1
    assert job_lease.lost_reason == "claim_taken_over"


@pytest.mark.asyncio
async def test_transient_heartbeat_errors_do_not_cancel_the_run() -> None:
    """Errors before the deadline are retried; the next successful
    extend renews the lease. The run is only stopped by the later
    0-rows result — a genuine takeover."""
    clock = _Clock()
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=3, acquired_at=0.0, clock=clock)
    lost_at_each_beat: list[bool] = []
    outcomes: list[Any] = [OSError("blip"), OSError("blip"), True, False]

    async def extend(*_a: Any, **_k: Any) -> bool:
        lost_at_each_beat.append(job_lease.lost)
        out = outcomes.pop(0)
        if isinstance(out, BaseException):
            raise out
        return bool(out)

    async def fake_sleep(seconds: float) -> None:
        clock.t += seconds

    with patch.object(jobs, "extend_lease", new=extend):
        await poller._heartbeat(
            MagicMock(),
            _job(),
            _live_settings(JOB_LEASE_SECONDS=3),
            job_lease,
            sleep=fake_sleep,
            clock=clock,
        )
    assert lost_at_each_beat == [False, False, False, False]
    assert job_lease.lost_reason == "claim_taken_over"


@pytest.mark.asyncio
async def test_heartbeat_errors_past_the_lease_deadline_cancel_the_run() -> None:
    clock = _Clock()
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=3, acquired_at=0.0, clock=clock)

    async def fake_sleep(seconds: float) -> None:
        clock.t += seconds

    with patch.object(
        jobs, "extend_lease", new=AsyncMock(side_effect=OSError("db down"))
    ) as extend:
        await poller._heartbeat(
            MagicMock(),
            _job(),
            _live_settings(JOB_LEASE_SECONDS=3),
            job_lease,
            sleep=fake_sleep,
            clock=clock,
        )
    # Beats at t=1, 2 fail but the lease (until t=3) still holds; the
    # failure at t=3 finds it expired.
    assert extend.await_count == 3
    assert job_lease.lost_reason == "heartbeat_failing_past_expiry"


@pytest.mark.asyncio
async def test_lost_lease_stops_the_step_before_the_next_tool() -> None:
    """The heartbeat flags the takeover while tool `a` runs: tool `b`
    (same model turn) never executes and nothing is written after."""
    calls: list[str] = []
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=60)
    tools = [
        _tool("a", calls, on_call=lambda: job_lease.mark_lost("claim_taken_over")),
        _tool("b", calls),
    ]
    client = _FakeClient(
        deltas=[],
        final_content_seq=[[_tool_use("tu_a", "a"), _tool_use("tu_b", "b")], []],
    )

    def make(_p: Any, _c: Any, messages: list[dict[str, Any]], _ctx: Any = None) -> RunStepFn:
        return make_anthropic_step_fn(
            AnthropicStepConfig(
                client=client, model="m", system=None, messages=messages, tools=tools
            )
        )

    collected, sink = _list_sink()
    checkpoint = {"messages": [{"role": "user", "content": "go"}], "step": 0, "seq": 1}
    with (
        _db(checkpoint, max_seq=1, sink=sink),
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save,
        patch.object(store, "update_run", new=AsyncMock()) as update,
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
        lease.bound(job_lease),
        pytest.raises(LeaseLostError),
    ):
        await executor.execute_start(
            MagicMock(), StartActionPayload(run_id=RUN_ID, user_id=USER_ID), make_step_fn=make
        )

    assert calls == ["a"]
    # The last event written is tool `a`'s input; its output (and
    # everything after) was refused.
    assert isinstance(collected[-1], ToolInputEvent) and collected[-1].tool_call_id == "tu_a"
    assert not any(isinstance(e, ToolOutputEvent | ResultEvent) for e in collected)
    save.assert_not_called()
    update.assert_not_called()
    settle.assert_not_called()


@pytest.mark.asyncio
async def test_tool_loop_checks_the_lease_right_before_executing() -> None:
    """Even with an emitter that doesn't guard its writes, the tool loop
    itself refuses to run a side-effecting tool without the lease."""
    calls: list[str] = []
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=60)
    tools = [
        _tool("a", calls, on_call=lambda: job_lease.mark_lost("claim_taken_over")),
        _tool("b", calls),
    ]
    client = _FakeClient(
        deltas=[], final_content_seq=[[_tool_use("tu_a", "a"), _tool_use("tu_b", "b")]]
    )
    _, sink = _list_sink()
    emitter = RunEmitter(run_id=RUN_ID, sink=sink)
    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="m",
            system=None,
            messages=[{"role": "user", "content": "go"}],
            tools=tools,
        )
    )
    with lease.bound(job_lease), pytest.raises(LeaseLostError):
        await step(RunStepContext(step=1, emitter=emitter))
    assert calls == ["a"]


@pytest.mark.asyncio
async def test_poller_abandons_a_job_whose_lease_was_taken_over() -> None:
    """Real heartbeat → 0 rows; the run stops at its next lease check;
    neither the job nor the task is settled (the new owner does that)."""
    settings = _live_settings(JOB_LEASE_SECONDS=0.3, JOB_HEARTBEAT_SECONDS=0.02)
    reached_end = False

    async def cooperative_run(*_a: Any, **_k: Any) -> ExecutorOutcome:
        nonlocal reached_end
        for _ in range(100):
            lease.check_current()
            await asyncio.sleep(0.01)
        reached_end = True
        return ExecutorOutcome(settled=True)

    with (
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(executor, "execute_start", new=cooperative_run),
        patch.object(jobs, "extend_lease", new=AsyncMock(return_value=False)),
        patch.object(jobs, "mark_job_done", new=AsyncMock()) as done,
        patch.object(jobs, "mark_job_failed", new=AsyncMock()) as failed,
        patch.object(jobs, "hand_back_job", new=AsyncMock()) as hand_back,
        patch.object(executor, "settle_stranded_task", new=AsyncMock()) as stranded,
    ):
        await poller._execute_claimed(MagicMock(), _job(), settings)

    assert reached_end is False
    done.assert_not_called()
    failed.assert_not_called()
    hand_back.assert_not_called()
    stranded.assert_not_called()


@pytest.mark.asyncio
async def test_poller_keeps_running_through_transient_heartbeat_errors() -> None:
    settings = _live_settings(JOB_LEASE_SECONDS=0.5, JOB_HEARTBEAT_SECONDS=0.02)

    async def cooperative_run(*_a: Any, **_k: Any) -> ExecutorOutcome:
        for _ in range(10):
            lease.check_current()
            await asyncio.sleep(0.01)
        return ExecutorOutcome(settled=True)

    pool = MagicMock()
    with (
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(executor, "execute_start", new=cooperative_run),
        patch.object(
            jobs, "extend_lease", new=AsyncMock(side_effect=OSError("conn reset"))
        ) as extend,
        patch.object(jobs, "mark_job_done", new=AsyncMock(return_value=True)) as done,
    ):
        await poller._execute_claimed(pool, _job(), settings)

    assert extend.await_count >= 2
    done.assert_awaited_once_with(pool, JOB_ID, attempts=2)


# --- 2. reclaimed start -----------------------------------------------------


@pytest.mark.asyncio
async def test_reclaimed_start_resumes_from_a_saved_checkpoint() -> None:
    checkpoint = {
        "messages": [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": [{"type": "text", "text": "part 1"}]},
            {"role": "user", "content": "keep going"},
        ],
        "step": 3,
        "seq": 12,
        "config": {},
    }
    collected, sink = _list_sink()
    seen: list[list[dict[str, Any]]] = []
    with (
        _db(checkpoint, max_seq=12, sink=sink),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
    ):
        outcome = await executor.execute_start(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step_fn(seen),
            reclaimed=True,
        )

    assert outcome.settled is True
    assert seen[0] == checkpoint["messages"]
    # Continue-style: no fresh `status: running`; numbering follows the
    # checkpoint.
    first = collected[0]
    assert isinstance(first, StepStartEvent)
    assert (first.seq, first.step) == (13, 4)
    assert not any(isinstance(e, StatusEvent) for e in collected)
    assert settle.await_args.kwargs["status"] == "done"


@pytest.mark.asyncio
async def test_reclaimed_start_without_a_checkpoint_restarts_behind_a_marker() -> None:
    checkpoint = {"messages": [{"role": "user", "content": "go"}], "step": 0, "seq": 1}
    collected, sink = _list_sink()
    with (
        _db(checkpoint, max_seq=9, sink=sink),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()),
    ):
        outcome = await executor.execute_start(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step_fn(),
            reclaimed=True,
        )

    assert outcome.settled is True
    marker = collected[0]
    assert isinstance(marker, StatusEvent)
    # Follows the dead attempt's events (max seq 9), restarts at step 0.
    assert (marker.status, marker.restarted, marker.seq, marker.step) == ("running", True, 10, 0)
    assert event_to_row_payload(marker) == {"status": "running", "restarted": True}
    # Only the marker carries the flag.
    assert [e.restarted for e in collected if isinstance(e, StatusEvent)] == [True]


@pytest.mark.asyncio
async def test_fresh_start_emits_no_restart_marker() -> None:
    checkpoint = {"messages": [{"role": "user", "content": "go"}], "step": 0, "seq": 1}
    collected, sink = _list_sink()
    with (
        _db(checkpoint, max_seq=1, sink=sink),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()),
    ):
        await executor.execute_start(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step_fn(),
        )
    marker = collected[0]
    assert isinstance(marker, StatusEvent) and marker.restarted is False
    assert event_to_row_payload(marker) == {"status": "running"}


@pytest.mark.asyncio
async def test_poller_reruns_a_reclaimed_start_as_reclaimed() -> None:
    with (
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(jobs, "load_job_task_state", new=AsyncMock(return_value=_state())),
        patch.object(
            executor,
            "execute_start",
            new=AsyncMock(return_value=ExecutorOutcome(settled=True)),
        ) as ex_start,
        patch.object(jobs, "mark_job_done", new=AsyncMock(return_value=True)),
    ):
        await poller._execute_claimed(MagicMock(), _job(reclaimed=True), _live_settings())
    assert ex_start.await_args.kwargs == {"reclaimed": True}


def _ev(kind: type, seq: int, **kw: Any) -> Any:
    return kind(run_id=RUN_ID, seq=seq, step=0, created_at="t", **kw)


def test_restart_marker_drops_the_dead_attempts_text_from_the_final_answer() -> None:
    events: list[TaskEvent] = [
        _ev(StatusEvent, 2, status="running"),
        _ev(TokenEvent, 3, text="half an ans"),
        _ev(StatusEvent, 4, status="running", restarted=True),
        _ev(TokenEvent, 5, text="the answer"),
    ]
    assert verify.aggregate_from_events(events).text == "the answer"


def test_restart_marker_survives_the_row_round_trip() -> None:
    marker = _ev(StatusEvent, 4, status="running", restarted=True)
    decoded = store.event_from_row_payload(
        seq=4, step=0, kind="status", created_at="t", payload=event_to_row_payload(marker)
    )
    assert isinstance(decoded, StatusEvent) and decoded.restarted is True


# --- 3. interrupted respond -------------------------------------------------


def _paused_checkpoint(*, answered: bool) -> dict[str, Any]:
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": "go"},
        {"role": "assistant", "content": [_tool_use("tu_1", "danger")]},
    ]
    if answered:
        messages.append(
            {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "tu_1", "content": "did it"}],
            }
        )
    return {
        "messages": messages,
        "step": 1,
        "seq": 8,
        "config": {"requireApprovalFor": ["danger"]},
    }


def _respond_payload(request_id: str = "tu_1") -> executor.RespondActionPayload:
    return executor.RespondActionPayload(
        run_id=RUN_ID, user_id=USER_ID, request_id=request_id, approved=True
    )


@pytest.mark.asyncio
async def test_interrupted_respond_reapplies_an_unpersisted_answer() -> None:
    """Dead attempt flipped paused → running but died before saving the
    tool_result: the reclaimed job re-applies the payload's answer
    without going through the (now closed) paused gate."""
    calls: list[str] = []
    collected, sink = _list_sink()
    with (
        _db(_paused_checkpoint(answered=False), max_seq=10, sink=sink),
        patch(
            "agent_py.executor.default_tool_registry",
            return_value={"danger": _tool("danger", calls)},
        ),
        patch.object(store, "claim_paused_for_respond", new=AsyncMock()) as claim,
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save,
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
    ):
        outcome = await executor.execute_respond(
            MagicMock(),
            _respond_payload(),
            make_step_fn=_done_step_fn(),
            resume_interrupted=True,
        )

    assert outcome.settled is True
    claim.assert_not_called()
    assert calls == ["danger"]
    saved = save.await_args_list[0].kwargs["checkpoint"]["messages"][-1]["content"][0]
    assert (saved["tool_use_id"], saved["content"]) == ("tu_1", "danger ran")
    responses = [e for e in collected if isinstance(e, ApprovalEvent)]
    assert [(e.phase, e.approval_id, e.seq) for e in responses] == [("response", "tu_1", 11)]
    assert settle.await_args.kwargs["status"] == "done"


@pytest.mark.asyncio
async def test_interrupted_respond_with_a_persisted_answer_continues() -> None:
    calls: list[str] = []
    collected, sink = _list_sink()
    seen: list[list[dict[str, Any]]] = []
    checkpoint = _paused_checkpoint(answered=True)
    with (
        _db(checkpoint, max_seq=11, sink=sink),
        patch(
            "agent_py.executor.default_tool_registry",
            return_value={"danger": _tool("danger", calls)},
        ),
        patch.object(store, "claim_paused_for_respond", new=AsyncMock()) as claim,
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
    ):
        outcome = await executor.execute_respond(
            MagicMock(),
            _respond_payload(),
            make_step_fn=_done_step_fn(seen),
            resume_interrupted=True,
        )

    assert outcome.settled is True
    claim.assert_not_called()
    # Not re-executed, not re-answered: the run just carries on.
    assert calls == []
    assert seen[0] == checkpoint["messages"]
    assert not any(isinstance(e, ApprovalEvent) for e in collected)
    assert collected[0].seq == 12
    assert settle.await_args.kwargs["status"] == "done"


@pytest.mark.asyncio
async def test_interrupted_respond_that_cannot_resume_settles_the_task_failed() -> None:
    """The task is `running` on this job's account — a rejection must
    settle it rather than strand it."""
    collected, sink = _list_sink()
    with (
        _db(_paused_checkpoint(answered=False), max_seq=10, sink=sink),
        patch(
            "agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())
        ) as settle,
    ):
        outcome = await executor.execute_respond(
            MagicMock(), _respond_payload("tu_missing"), resume_interrupted=True
        )
    assert outcome.settled is False
    assert settle.await_args.kwargs["status"] == "failed"
    assert [e.status for e in collected if isinstance(e, ResultEvent)] == ["failed"]


@pytest.mark.asyncio
async def test_respond_without_the_lease_runs_no_tool_and_claims_nothing() -> None:
    calls: list[str] = []
    _, sink = _list_sink()
    lost = JobLease(job_id=JOB_ID, lease_seconds=60)
    lost.mark_lost("claim_taken_over")
    with (
        _db(_paused_checkpoint(answered=False), max_seq=10, sink=sink),
        patch(
            "agent_py.executor.default_tool_registry",
            return_value={"danger": _tool("danger", calls)},
        ),
        patch.object(store, "claim_paused_for_respond", new=AsyncMock()) as claim,
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
        lease.bound(lost),
        pytest.raises(LeaseLostError),
    ):
        await executor.execute_respond(MagicMock(), _respond_payload())
    claim.assert_not_called()
    settle.assert_not_called()
    assert calls == []
