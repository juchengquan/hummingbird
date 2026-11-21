"""The interactive run driver (`runs/driver.py`) against the 3a fakes:
lifecycle and terminal entries, local and cross-process cancel, lease
loss, the reaper, shutdown, and the stub harness it runs in conformance."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from agent_py.emitter import RunEmitter
from agent_py.events import ApprovalEvent, ResultEvent, StatusEvent
from agent_py.runs.driver import RunDriver, reap_interactive_runs
from agent_py.runs.event_log import InMemoryRunEventLog
from agent_py.runs.harness import CancelSignal, HarnessResult, RunInput, ScriptedHarness
from agent_py.runs.model import (
    Failed,
    Interrupted,
    PendingInterrupt,
    RunOwner,
    RunRecord,
    RunResultData,
    Succeeded,
)
from agent_py.runs.repository import InMemoryRunRepository, RunSpec
from agent_py.runs.stub_harness import StubHarness

RUN = "00000000-0000-4000-8000-0000000000c1"
THREAD = "00000000-0000-4000-8000-0000000000a0"
OWNER = RunOwner.user("00000000-0000-4000-8000-000000000123")


async def _setup(
    repo: InMemoryRunRepository | None = None,
) -> tuple[InMemoryRunRepository, InMemoryRunEventLog, RunRecord]:
    repo = repo or InMemoryRunRepository()
    log = InMemoryRunEventLog(tick=0.01)
    created = await repo.create(OWNER, RunSpec(run_id=RUN, thread_id=THREAD, mode="interactive"))
    return repo, log, created.run


def _input(**kw: object) -> RunInput:
    return RunInput(
        run_id=RUN,
        thread_id=THREAD,
        mode="interactive",
        user_id=OWNER.user_id,
        messages=({"id": "m", "role": "user", "content": "hi"},),
        **kw,  # type: ignore[arg-type]
    )


def _driver(**kw: object) -> RunDriver:
    return RunDriver(lease_seconds=30, heartbeat_seconds=0.02, **kw)  # type: ignore[arg-type]


async def test_success_appends_result_then_settles_and_seals() -> None:
    repo, log, run = await _setup()
    settled: list[RunRecord] = []

    async def hook(r: RunRecord) -> None:
        settled.append(r)

    harness = ScriptedHarness(
        [ScriptedHarness.say("hello")],
        result=HarnessResult(Succeeded(RunResultData(text="hello", memory_tainted=True))),
    )
    driver = _driver(post_settle=hook)
    await driver.start(run=run, run_input=_input(), repo=repo, log=log, harness=harness)
    entries = await log.read(RUN)
    assert [e.kind for e in entries] == ["step_start", "token", "step_end", "result"]
    assert [e.seq for e in entries] == [1, 2, 3, 4]
    result = entries[-1]
    assert isinstance(result, ResultEvent) and result.status == "done"
    assert result.final_text == "hello" and result.memory_tainted
    final = await repo.get(OWNER, RUN)
    assert final is not None and final.status == "succeeded"
    assert final.result == {"text": "hello", "memoryTainted": True}
    assert [r.id for r in settled] == [RUN]
    assert not driver.is_local(RUN)
    # sealed: subscribers end, appends refuse
    assert [b async for b in log.subscribe(RUN)] == [entries]


async def test_interrupt_writes_requests_and_paused() -> None:
    repo, log, run = await _setup()
    interrupt = PendingInterrupt(id="i1", tool="send", args={"to": "x"}, prompt="Send?")
    harness = ScriptedHarness(result=HarnessResult(Interrupted((interrupt,))))
    await _driver().start(run=run, run_input=_input(), repo=repo, log=log, harness=harness)
    entries = await log.read(RUN)
    assert [e.kind for e in entries] == ["approval", "status"]
    req = entries[0]
    assert isinstance(req, ApprovalEvent) and req.phase == "request" and req.approval_id == "i1"
    assert isinstance(entries[1], StatusEvent) and entries[1].status == "paused"
    final = await repo.get(OWNER, RUN)
    assert final is not None and final.status == "interrupted"
    assert final.open_interrupts == (interrupt.to_agui(),)


async def test_failure_and_harness_exception() -> None:
    repo, log, run = await _setup()
    harness = ScriptedHarness(result=HarnessResult(Failed("provider", "boom")))
    await _driver().start(run=run, run_input=_input(), repo=repo, log=log, harness=harness)
    result = (await log.read(RUN))[-1]
    assert isinstance(result, ResultEvent)
    assert (result.status, result.error_code, result.error) == ("failed", "provider", "boom")

    class Exploding:
        name = "exploding"

        async def run(self, ri: RunInput, em: RunEmitter, cancel: CancelSignal) -> HarnessResult:
            raise RuntimeError("bug")

    repo2, log2, run2 = await _setup()
    await _driver().start(run=run2, run_input=_input(), repo=repo2, log=log2, harness=Exploding())
    final = await repo2.get(OWNER, RUN)
    assert final is not None and final.error is not None and final.error["code"] == "unknown"


async def test_local_cancel_stops_the_harness_and_logs_cancelled() -> None:
    repo, log, run = await _setup()
    harness = ScriptedHarness([ScriptedHarness.say(str(i)) for i in range(50)], step_delay=0.02)
    driver = _driver()
    task = driver.start(run=run, run_input=_input(), repo=repo, log=log, harness=harness)
    await asyncio.sleep(0.05)
    assert driver.is_local(RUN)
    await repo.cancel(OWNER, RUN)
    assert driver.signal_cancel(RUN)
    await task
    entries = await log.read(RUN)
    assert isinstance(entries[-1], StatusEvent) and entries[-1].status == "cancelled"
    assert len(entries) < 50 * 3
    final = await repo.get(OWNER, RUN)
    assert final is not None and final.status == "cancelled"


async def test_cancel_from_another_process_is_noticed_by_the_heartbeat() -> None:
    repo, log, run = await _setup()
    harness = ScriptedHarness([ScriptedHarness.say(str(i)) for i in range(200)], step_delay=0.01)
    driver = _driver()
    task = driver.start(run=run, run_input=_input(), repo=repo, log=log, harness=harness)
    await asyncio.sleep(0.03)
    await repo.cancel(OWNER, RUN)  # no signal: as if served elsewhere
    await asyncio.wait_for(task, timeout=2)
    last = (await log.read(RUN))[-1]
    assert isinstance(last, StatusEvent) and last.status == "cancelled"


async def test_heartbeat_keeps_the_lease_ahead_of_the_clock() -> None:
    start = datetime(2026, 11, 21, tzinfo=UTC)
    clock_now = [start]
    repo = InMemoryRunRepository(clock=lambda: clock_now[0])
    log = InMemoryRunEventLog(tick=0.01)
    spec = RunSpec(run_id=RUN, thread_id=THREAD, mode="interactive", lease_seconds=10)
    run = (await repo.create(OWNER, spec)).run
    assert run.lease_expires_at == start + timedelta(seconds=10)
    harness = ScriptedHarness([ScriptedHarness.say("x")] * 50, step_delay=0.01)
    task = _driver().start(run=run, run_input=_input(), repo=repo, log=log, harness=harness)
    for _ in range(5):  # 50 s of clock: the first lease would have lapsed
        clock_now[0] += timedelta(seconds=10)
        await asyncio.sleep(0.05)
    current = await repo.get(OWNER, RUN)
    assert current is not None and current.is_live
    assert current.lease_expires_at is not None
    assert current.lease_expires_at > start + timedelta(seconds=40)
    assert await reap_interactive_runs(repo, log) == 0
    await task


async def test_reaper_fails_lapsed_runs_of_dead_processes() -> None:
    clock_now = [datetime(2026, 11, 21, tzinfo=UTC)]
    repo = InMemoryRunRepository(clock=lambda: clock_now[0])
    repo, log, _run = await _setup(repo)
    emitter = RunEmitter(run_id=RUN, sink=lambda e: log.append(e))  # type: ignore[arg-type,return-value]
    await emitter.start_step()
    await emitter.token("partial")
    assert await reap_interactive_runs(repo, log) == 0  # lease not lapsed yet
    clock_now[0] += timedelta(minutes=10)
    assert await reap_interactive_runs(repo, log) == 1
    entries = await log.read(RUN)
    last = entries[-1]
    assert isinstance(last, ResultEvent) and last.error_code == "worker_lost"
    assert last.seq == 3 and last.step == 1
    final = await repo.get(OWNER, RUN)
    assert final is not None and final.status == "failed"
    assert final.error is not None and final.error["code"] == "worker_lost"
    assert [b async for b in log.subscribe(RUN)] == [entries]  # sealed


async def test_reaper_leaves_a_local_run_to_its_driver() -> None:
    clock_now = [datetime(2026, 11, 21, tzinfo=UTC)]
    repo = InMemoryRunRepository(clock=lambda: clock_now[0])
    repo, log, run = await _setup(repo)
    harness = ScriptedHarness([ScriptedHarness.say(str(i)) for i in range(100)], step_delay=0.01)
    driver = RunDriver(lease_seconds=30, heartbeat_seconds=60)
    task = driver.start(run=run, run_input=_input(), repo=repo, log=log, harness=harness)
    await asyncio.sleep(0.03)
    clock_now[0] += timedelta(minutes=10)
    assert await reap_interactive_runs(repo, log, driver=driver) == 1
    await asyncio.wait_for(task, timeout=2)
    entries = await log.read(RUN)
    assert [e.seq for e in entries] == list(range(1, len(entries) + 1))  # one writer, no gaps
    last = entries[-1]
    assert isinstance(last, ResultEvent) and last.error_code == "worker_lost"


async def test_shutdown_fails_local_runs_as_worker_lost() -> None:
    repo, log, run = await _setup()
    harness = ScriptedHarness([ScriptedHarness.say(str(i)) for i in range(100)], step_delay=0.02)
    driver = _driver()
    driver.start(run=run, run_input=_input(), repo=repo, log=log, harness=harness)
    await asyncio.sleep(0.03)
    await driver.shutdown(grace_s=2)
    final = await repo.get(OWNER, RUN)
    assert final is not None and final.status == "failed"
    assert final.error is not None and final.error["code"] == "worker_lost"
    assert not driver.is_local(RUN)


async def test_stub_harness_outcomes() -> None:
    for outcome, expected in (
        ("succeed", "succeeded"),
        ("fail", "failed"),
        ("interrupt", "interrupted"),
    ):
        repo, log, run = await _setup()
        ri = _input(options={"conformance": {"outcome": outcome, "steps": 2}})
        await _driver().start(run=run, run_input=ri, repo=repo, log=log, harness=StubHarness())
        final = await repo.get(OWNER, RUN)
        assert final is not None and final.status == expected, outcome
        tokens = [e for e in await log.read(RUN) if e.kind == "token"]
        assert len(tokens) == 2


# --- wave 3b: coalescing, log caps, the resume checkpoint ---------------------------


async def test_text_deltas_are_coalesced_before_they_get_a_seq() -> None:
    repo, log, run = await _setup()

    async def chatty(emitter: RunEmitter) -> None:
        for piece in ("hel", "lo ", "wor", "ld"):
            await emitter.token(piece)

    harness = ScriptedHarness([chatty], result=HarnessResult(Succeeded()))
    await _driver().start(run=run, run_input=_input(), repo=repo, log=log, harness=harness)
    entries = await log.read(RUN)
    assert [e.kind for e in entries] == ["step_start", "token", "step_end", "result"]
    assert getattr(entries[1], "text", None) == "hello world"


async def test_a_full_memory_log_fails_the_run_with_its_terminal_entry() -> None:
    from agent_py.runs.event_log_memory import MemoryRunEventLog

    repo = InMemoryRunRepository()
    run = (await repo.create(OWNER, RunSpec(run_id=RUN, thread_id=THREAD, mode="interactive"))).run
    log = MemoryRunEventLog(max_entries_per_run=3, tick=0.01)

    say = ScriptedHarness.say("x")
    harness = ScriptedHarness([say, say, say], result=HarnessResult(Succeeded()))
    await _driver().start(run=run, run_input=_input(), repo=repo, log=log, harness=harness)
    entries = await log.read(RUN)
    assert [e.seq for e in entries] == list(range(1, len(entries) + 1))  # no hole
    last = entries[-1]
    assert isinstance(last, ResultEvent) and last.status == "failed"
    assert last.error_code == "limit_reached"
    final = await repo.get(OWNER, RUN)
    assert final is not None and final.status == "failed"
    assert final.error is not None and final.error["code"] == "limit_reached"


_CHECKPOINT = {"harness": "scripted", "turn": ["opaque"]}


def _interrupt() -> Interrupted:
    return Interrupted(
        (PendingInterrupt(id="c1", request_kind="approval", tool="t", tool_call_id="c1"),)
    )


async def test_an_interrupted_runs_checkpoint_reaches_its_resume_run() -> None:
    from agent_py.runs.harness import ResumeAnswer

    repo, log, run = await _setup()
    first = ScriptedHarness([], result=HarnessResult(_interrupt(), checkpoint=_CHECKPOINT))
    await _driver().start(run=run, run_input=_input(), repo=repo, log=log, harness=first)
    assert repo.checkpoint_of(RUN) == _CHECKPOINT
    assert await repo.load_checkpoint(OWNER, RUN) == _CHECKPOINT
    assert (
        await repo.load_checkpoint(RunOwner.user("00000000-0000-4000-8000-0000000000ff"), RUN)
        is None
    )

    resume_id = "00000000-0000-4000-8000-0000000000c2"
    resumed = (
        await repo.create(
            OWNER,
            RunSpec(run_id=resume_id, thread_id=THREAD, mode="interactive", previous_run_id=RUN),
        )
    ).run
    second = ScriptedHarness([], result=HarnessResult(Succeeded()))
    run_input = RunInput(
        run_id=resume_id,
        thread_id=THREAD,
        mode="interactive",
        user_id=OWNER.user_id,
        messages=(),
        resume=(ResumeAnswer("c1", "resolved", {"approved": True}),),
        previous_run_id=RUN,
    )
    await _driver().start(run=resumed, run_input=run_input, repo=repo, log=log, harness=second)
    assert second.inputs[0].previous_checkpoint == _CHECKPOINT
    # A run that is not a resume gets none; a success stores none.
    assert repo.checkpoint_of(resume_id) is None


async def test_a_resume_run_of_another_owner_gets_no_checkpoint() -> None:
    from agent_py.runs.harness import ResumeAnswer
    from agent_py.runs.repository_memory import MemoryRunRepository

    repo = MemoryRunRepository(ttl_seconds=60, max_runs=10)
    log = InMemoryRunEventLog(tick=0.01)
    alice, mallory = RunOwner.anonymous("a" * 32), RunOwner.anonymous("m" * 32)
    run = (await repo.create(alice, RunSpec(run_id=RUN, thread_id=THREAD, mode="interactive"))).run
    first = ScriptedHarness([], result=HarnessResult(_interrupt(), checkpoint=_CHECKPOINT))
    anonymous_input = RunInput(
        run_id=RUN, thread_id=THREAD, mode="interactive", user_id=None, messages=()
    )
    await _driver().start(run=run, run_input=anonymous_input, repo=repo, log=log, harness=first)
    assert await repo.load_checkpoint(alice, RUN) == _CHECKPOINT
    assert await repo.load_checkpoint(mallory, RUN) is None

    other_id = "00000000-0000-4000-8000-0000000000c3"
    other = (
        await repo.create(mallory, RunSpec(run_id=other_id, thread_id=THREAD, mode="interactive"))
    ).run
    second = ScriptedHarness([], result=HarnessResult(Succeeded()))
    await _driver().start(
        run=other,
        run_input=RunInput(
            run_id=other_id,
            thread_id=THREAD,
            mode="interactive",
            user_id=None,
            messages=(),
            resume=(ResumeAnswer("c1", "resolved", {"approved": True}),),
            previous_run_id=RUN,
        ),
        repo=repo,
        log=log,
        harness=second,
    )
    assert second.inputs[0].previous_checkpoint is None
