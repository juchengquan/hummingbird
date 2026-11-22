"""Recovery when a job's lease is lost or its worker died mid-run.

Follow-ups to the lease work in `test_job_lease.py`:

  1. Lost lease → the run stops cooperatively: no further events, no
     tool execution, no checkpoint / task / job settle. A transient
     heartbeat error does NOT stop it unless the lease would have
     expired by then.
  2. Reclaimed `start` / `continue` → resumes from the checkpoint (a
     `start` restarts from its initial one when the dead attempt saved
     none) behind a `status: running` marker carrying `resumedFromSeq`,
     which consumers use to drop the dead attempt's partial output
     written past that checkpoint. A normal `continue` emits no marker.
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
    ToolCallResult,
    ToolInputEvent,
    ToolOutputEvent,
    drop_superseded_events,
    event_to_row_payload,
    resume_discard_range,
)
from agent_py.executor import ExecutorOutcome, StartActionPayload
from agent_py.lease import JobLease, LeaseLostError
from agent_py.providers.anthropic_provider import AnthropicStepConfig, make_anthropic_step_fn
from agent_py.runner import RunStepContext, RunStepFn, RunStepOutcome
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

from .executor_fakes import fake_settle
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


def saved_at(calls: list[str]) -> bool:
    assert calls == [], "saved after the lease was lost"
    return True


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
        patch.object(
            store, "save_checkpoint", new=AsyncMock(side_effect=lambda *_a, **_k: saved_at(calls))
        ) as save,
        patch.object(store, "update_run", new=AsyncMock()) as update,
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
        lease.bound(job_lease),
        pytest.raises(LeaseLostError),
    ):
        await executor.execute_start(
            MagicMock(), StartActionPayload(run_id=RUN_ID, user_id=USER_ID), make_step_fn=make
        )

    assert calls == ["a"]
    # The last events written are the turn's inputs; `a`'s output (and
    # everything after) was refused.
    assert isinstance(collected[-1], ToolInputEvent)
    assert [e.tool_call_id for e in collected if isinstance(e, ToolInputEvent)] == ["tu_a", "tu_b"]
    assert not any(isinstance(e, ToolOutputEvent | ResultEvent) for e in collected)
    # Only the turn's record, saved while the lease held (before `a` ran).
    assert save.await_count == 1
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
        patch.object(store, "load_owned_task_status", new=AsyncMock(return_value="queued")),
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
        patch.object(store, "load_owned_task_status", new=AsyncMock(return_value="queued")),
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
        # The dead attempt wrote seqs 13..15 past the checkpoint.
        _db(checkpoint, max_seq=15, sink=sink),
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
    # Continue-style numbering (step follows the checkpoint), opened by a
    # resume marker that discards the dead attempt's seqs 13..15.
    marker, first = collected[0], collected[1]
    assert isinstance(marker, StatusEvent)
    assert (marker.status, marker.resumed_from_seq, marker.restarted) == ("running", 12, False)
    assert (marker.seq, marker.step) == (16, 3)
    assert event_to_row_payload(marker) == {"status": "running", "resumedFromSeq": 12}
    assert isinstance(first, StepStartEvent)
    assert (first.seq, first.step) == (17, 4)
    assert [e for e in collected if isinstance(e, StatusEvent)] == [marker]
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
    # Follows the dead attempt's events (max seq 9), restarts at step 0,
    # resumed from the initial checkpoint (seq 1). `restarted` stays on
    # for readers that predate `resumedFromSeq`.
    assert (marker.status, marker.restarted, marker.seq, marker.step) == ("running", True, 10, 0)
    assert marker.resumed_from_seq == 1
    assert event_to_row_payload(marker) == {
        "status": "running",
        "resumedFromSeq": 1,
        "restarted": True,
    }
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
    assert marker.resumed_from_seq is None
    assert event_to_row_payload(marker) == {"status": "running"}


def _continue_checkpoint() -> dict[str, Any]:
    return {
        "messages": [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": [{"type": "text", "text": "part 1"}]},
            {"role": "user", "content": "keep going"},
        ],
        "step": 2,
        "seq": 6,
        "config": {},
    }


#: The run's log as the dead `continue` chunk left it: the first chunk's
#: output up to the checkpoint (seq 6), then partial output past it.
_DEAD_CHUNK_LOG: list[TaskEvent] = [
    StatusEvent(run_id=RUN_ID, seq=2, step=0, created_at="t", status="running"),
    StepStartEvent(run_id=RUN_ID, seq=3, step=1, created_at="t"),
    TokenEvent(run_id=RUN_ID, seq=4, step=1, created_at="t", text="part 1. "),
    StepStartEvent(run_id=RUN_ID, seq=7, step=3, created_at="t"),
    TokenEvent(run_id=RUN_ID, seq=8, step=3, created_at="t", text="ans"),
]


async def _run_continue(*, reclaimed: bool) -> tuple[list[TaskEvent], ExecutorOutcome]:
    """Run a `continue` against `_DEAD_CHUNK_LOG`; `load_run_events`
    returns that log plus whatever this chunk wrote."""
    collected, sink = _list_sink()

    async def load_log(*_a: Any, **_kw: Any) -> list[TaskEvent]:
        return [*_DEAD_CHUNK_LOG, *collected]

    with (
        _db(_continue_checkpoint(), max_seq=8, sink=sink),
        patch.object(store, "load_run_events", new=AsyncMock(side_effect=load_log)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor.settle_task_terminal", new=fake_settle(collected)),
    ):
        outcome = await executor.execute_continue(
            MagicMock(),
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            make_step_fn=_done_step_fn(),
            reclaimed=reclaimed,
        )
    return collected, outcome


@pytest.mark.asyncio
async def test_reclaimed_continue_opens_with_a_resume_marker() -> None:
    collected, outcome = await _run_continue(reclaimed=True)
    assert outcome.settled is True
    marker = collected[0]
    assert isinstance(marker, StatusEvent)
    # Past the dead attempt's max seq (8), at the checkpoint's step.
    assert (marker.seq, marker.step, marker.status) == (9, 2, "running")
    assert (marker.resumed_from_seq, marker.restarted) == (6, False)
    assert [e for e in collected if isinstance(e, StatusEvent)] == [marker]


@pytest.mark.asyncio
async def test_reclaimed_continue_final_text_excludes_the_dead_chunks_output() -> None:
    collected, _ = await _run_continue(reclaimed=True)
    result = collected[-1]
    assert isinstance(result, ResultEvent) and result.status == "done"
    # "ans" (seq 8) was the dead chunk's — only the checkpointed text and
    # the re-run's answer remain.
    assert result.final_text == "part 1. answer"


@pytest.mark.asyncio
async def test_normal_continue_emits_no_resume_marker() -> None:
    collected, outcome = await _run_continue(reclaimed=False)
    assert outcome.settled is True
    assert not any(isinstance(e, StatusEvent) for e in collected)
    assert isinstance(collected[0], StepStartEvent)
    assert collected[0].seq == 9


@pytest.mark.asyncio
async def test_poller_reruns_a_reclaimed_continue_as_reclaimed() -> None:
    with (
        patch.object(store, "load_owned_task_status", new=AsyncMock(return_value="queued")),
        patch.object(jobs, "load_job_task_state", new=AsyncMock(return_value=_state())),
        patch.object(
            executor,
            "execute_continue",
            new=AsyncMock(return_value=ExecutorOutcome(settled=True)),
        ) as ex_continue,
        patch.object(jobs, "mark_job_done", new=AsyncMock(return_value=True)),
    ):
        await poller._execute_claimed(
            MagicMock(), _job(action="continue", reclaimed=True), _live_settings()
        )
    assert ex_continue.await_args.kwargs == {"reclaimed": True}


@pytest.mark.asyncio
async def test_poller_runs_a_fresh_continue_without_a_marker() -> None:
    with (
        patch.object(store, "load_owned_task_status", new=AsyncMock(return_value="queued")),
        patch.object(
            executor,
            "execute_continue",
            new=AsyncMock(return_value=ExecutorOutcome(settled=True)),
        ) as ex_continue,
        patch.object(jobs, "mark_job_done", new=AsyncMock(return_value=True)),
    ):
        await poller._execute_claimed(MagicMock(), _job(action="continue"), _live_settings())
    assert ex_continue.await_args.kwargs == {}


@pytest.mark.asyncio
async def test_poller_reruns_a_reclaimed_start_as_reclaimed() -> None:
    with (
        patch.object(store, "load_owned_task_status", new=AsyncMock(return_value="queued")),
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


def test_resume_marker_drops_only_the_range_past_its_checkpoint() -> None:
    events: list[TaskEvent] = [
        _ev(StatusEvent, 1, status="queued"),
        _ev(TokenEvent, 2, text="kept "),
        _ev(TokenEvent, 3, text="also kept "),
        _ev(TokenEvent, 4, text="dead "),
        _ev(TokenEvent, 5, text="dead too "),
        _ev(StatusEvent, 6, status="running", resumed_from_seq=3),
        _ev(TokenEvent, 7, text="live"),
    ]
    kept = drop_superseded_events(events)
    assert [e.seq for e in kept] == [1, 2, 3, 6, 7]
    assert verify.aggregate_from_events(events).text == "kept also kept live"


def test_resume_marker_drops_superseded_sources_and_renumbers() -> None:
    def out(seq: int, url: str) -> ToolOutputEvent:
        return _ev(
            ToolOutputEvent,
            seq,
            tool_call_id=f"t{seq}",
            tool_name="webSearch",
            summary="1 result",
            results=[ToolCallResult(title=url, url=url, snippet="")],
        )

    events: list[TaskEvent] = [
        out(2, "a"),
        out(4, "dead"),
        _ev(StatusEvent, 5, status="running", resumed_from_seq=3),
        out(6, "b"),
    ]
    sources = verify.aggregate_from_events(events).sources
    assert [(s.id, s.url) for s in sources] == [("1", "a"), ("2", "b")]


def test_legacy_restart_marker_reads_as_resumed_from_seq_1() -> None:
    marker = _ev(StatusEvent, 5, status="running", restarted=True)
    assert resume_discard_range(marker) == (1, 5)
    assert resume_discard_range(_ev(StatusEvent, 6, status="running")) is None
    events: list[TaskEvent] = [
        _ev(StatusEvent, 1, status="queued"),
        _ev(StatusEvent, 2, status="running"),
        _ev(TokenEvent, 3, text="half"),
        marker,
    ]
    assert [e.seq for e in drop_superseded_events(events)] == [1, 5]


def test_restart_marker_survives_the_row_round_trip() -> None:
    marker = _ev(StatusEvent, 4, status="running", restarted=True, resumed_from_seq=1)
    decoded = store.event_from_row_payload(
        seq=4, step=0, kind="status", created_at="t", payload=event_to_row_payload(marker)
    )
    assert isinstance(decoded, StatusEvent) and decoded.restarted is True
    assert decoded.resumed_from_seq == 1
    # A legacy row (flag only) and a malformed value both decode without
    # a range of their own.
    legacy = store.event_from_row_payload(
        seq=4,
        step=0,
        kind="status",
        created_at="t",
        payload={"status": "running", "restarted": True},
    )
    assert isinstance(legacy, StatusEvent) and legacy.resumed_from_seq is None
    bad = store.event_from_row_payload(
        seq=4,
        step=0,
        kind="status",
        created_at="t",
        payload={"status": "running", "resumedFromSeq": "x"},
    )
    assert isinstance(bad, StatusEvent) and bad.resumed_from_seq is None


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
    # The dead attempt never recorded starting the tool, so it runs —
    # behind a fresh execution record (first save), then its result is
    # persisted (second save).
    assert calls == ["danger"]
    record = save.await_args_list[0].kwargs["checkpoint"]["inflight_tools"]
    assert (record["started"], record["results"]) == (["tu_1"], [])
    saved = save.await_args_list[2].kwargs["checkpoint"]["messages"][-1]["content"][0]
    assert (saved["tool_use_id"], saved["content"]) == ("tu_1", "danger ran")
    # Opens with a resume marker from the paused checkpoint (seq 8), then
    # re-emits the answer.
    marker = collected[0]
    assert isinstance(marker, StatusEvent)
    assert (marker.seq, marker.resumed_from_seq) == (11, 8)
    responses = [e for e in collected if isinstance(e, ApprovalEvent)]
    assert [(e.phase, e.approval_id, e.seq) for e in responses] == [("response", "tu_1", 12)]
    assert settle.await_args.kwargs["status"] == "done"
    # The interim checkpoint (answer applied) is saved AFTER the marker,
    # so its seq covers it: a reclaim from it drops only what follows.
    for saved_then in save.await_args_list:
        assert saved_then.kwargs["checkpoint"]["seq"] >= marker.seq


@pytest.mark.asyncio
async def test_interrupted_respond_emits_the_marker_before_the_interim_save() -> None:
    """Were the attempt to die between the interim save and the marker,
    the next reclaim would resume from the interim checkpoint with a
    marker at its seq and never drop the first dead attempt's events."""
    order: list[str] = []
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        order.append(f"event:{event.kind}")
        collected.append(event)

    saved_seqs: list[int] = []

    async def save(*_a: Any, **kw: Any) -> None:
        order.append("save")
        saved_seqs.append(kw["checkpoint"]["seq"])

    with (
        _db(_paused_checkpoint(answered=False), max_seq=10, sink=sink),
        patch(
            "agent_py.executor.default_tool_registry",
            return_value={"danger": _tool("danger", [])},
        ),
        patch.object(store, "save_checkpoint", new=AsyncMock(side_effect=save)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()),
    ):
        await executor.execute_respond(
            MagicMock(), _respond_payload(), make_step_fn=_done_step_fn(), resume_interrupted=True
        )
    assert order[0] == "event:status"
    marker = collected[0]
    assert isinstance(marker, StatusEvent) and marker.resumed_from_seq == 8
    # Every save follows the marker and the answer's entry, and covers both.
    assert order.index("save") > order.index("event:approval")
    assert saved_seqs and min(saved_seqs) > marker.seq == 11


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
    # Resumed behind a marker that drops what the dead attempt wrote past
    # the checkpoint (seqs 9..11).
    marker = collected[0]
    assert isinstance(marker, StatusEvent)
    assert (marker.seq, marker.resumed_from_seq) == (12, 8)
    assert settle.await_args.kwargs["status"] == "done"


@pytest.mark.asyncio
async def test_interrupted_respond_that_cannot_resume_settles_the_task_failed() -> None:
    """The task is `running` on this job's account — a rejection must
    settle it rather than strand it."""
    collected, sink = _list_sink()
    with (
        _db(_paused_checkpoint(answered=False), max_seq=10, sink=sink),
        patch("agent_py.executor.settle_task_terminal", new=fake_settle(collected)) as settle,
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
