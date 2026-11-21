"""The wave-3a run interfaces (`agent_py.runs`): the in-memory fakes keep
the promises their Protocols document, and the shared helpers produce
exactly what the contract (`packages/contract/openapi.yaml`) accepts —
checked against the generated Pydantic models, so a spec change that
breaks them fails here."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from agent_py.contract import models
from agent_py.emitter import RunEmitter
from agent_py.events import (
    ApprovalEvent,
    InputRequestOption,
    MessagesSnapshotEvent,
    ResultEvent,
    StatusEvent,
    SuggestionsEvent,
    TaskEvent,
    TokenEvent,
    TokenUsage,
    ToolImageEvent,
)
from agent_py.runs import (
    Cancelled,
    Failed,
    HarnessResult,
    InMemoryRunEventLog,
    InMemoryRunRepository,
    Interrupted,
    InvalidPageToken,
    PendingInterrupt,
    PreviousRunNotFound,
    RecordingEncoder,
    RunCursor,
    RunFilter,
    RunIdConflict,
    RunInput,
    RunOwner,
    RunResultData,
    RunSpec,
    ScriptedHarness,
    SeqConflict,
    Succeeded,
    ThreadNotFound,
    Yielded,
    contract_status,
    outcome_to_json,
    run_to_contract,
)

A = RunOwner.user("11111111-1111-4111-8111-111111111111")
B = RunOwner.user("22222222-2222-4222-8222-222222222222")
CONV = "c0000000-0000-4000-8000-0000000000c1"
THREAD = "f0000000-0000-4000-8000-0000000000f1"
BG_CHECKPOINT: dict[str, object] = {"messages": [], "config": {"model": "m"}}


def _rid(n: int) -> str:
    return f"e0000000-0000-4000-8000-{n:012d}"


def _tok(run_id: str, seq: int, text: str = "x") -> TokenEvent:
    return TokenEvent(run_id=run_id, seq=seq, step=1, created_at="t", text=text)


class _Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 21, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def tick(self, seconds: float = 1.0) -> None:
        self.now += timedelta(seconds=seconds)


def _repo(clock: _Clock | None = None) -> InMemoryRunRepository:
    return InMemoryRunRepository(conversations={A.user_id or "": {CONV}}, clock=clock or _Clock())


# --- model ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("internal", "interrupts", "expected"),
    [
        ("queued", False, "queued"),
        ("running", False, "running"),
        ("paused", True, "interrupted"),
        ("paused", False, "running"),  # background parent waiting on sub-agents
        ("done", False, "succeeded"),
        ("failed", False, "failed"),
        ("cancelled", False, "cancelled"),
    ],
)
def test_contract_status(internal: str, interrupts: bool, expected: str) -> None:
    assert contract_status(internal, has_open_interrupts=interrupts) == expected  # type: ignore[arg-type]


def test_run_owner() -> None:
    assert RunOwner.anonymous("tok") == RunOwner.anonymous("tok")
    assert RunOwner.anonymous("tok") != RunOwner.anonymous("other")
    assert "tok" not in (RunOwner.anonymous("tok").anonymous_key or "")
    with pytest.raises(ValueError):
        RunOwner()
    with pytest.raises(ValueError):
        RunOwner(user_id="u", anonymous_key="k")


def test_pending_interrupt_is_a_valid_agui_interrupt() -> None:
    choice = PendingInterrupt(
        id="tc1",
        request_kind="choice",
        tool="askUser",
        tool_call_id="tc1",
        args={"prompt": "Which?"},
        prompt="Which?",
        options=(InputRequestOption(id="a", label="A"),),
        multi=False,
    )
    agui = choice.to_agui()
    models.Interrupt.model_validate(agui)  # closed AG-UI schema: no stray keys
    assert agui["reason"] == "choice"
    assert agui["message"] == "Which?"
    assert agui["metadata"] == {
        "hummingbird": {
            "tool": "askUser",
            "args": {"prompt": "Which?"},
            "options": [{"id": "a", "label": "A"}],
            "multi": False,
        }
    }
    for kind in ("approval", "input", "ui-part"):
        models.Interrupt.model_validate(PendingInterrupt(id="x", request_kind=kind).to_agui())  # type: ignore[arg-type]


def test_pending_interrupt_from_approval_event_round_trips() -> None:
    req = ApprovalEvent(
        run_id="r",
        seq=3,
        step=1,
        created_at="t",
        approval_id="tc9",
        phase="request",
        request_kind="ui-part",
        tool="renderUI",
        tool_call_id="tc9",
        args={"kind": "confirm"},
        ui_kind="confirm",
        ui_props={"title": "Sure?"},
    )
    p = PendingInterrupt.from_approval(req)
    assert (p.id, p.request_kind, p.ui_kind) == ("tc9", "ui-part", "confirm")
    assert (
        PendingInterrupt.from_approval(
            ApprovalEvent(
                run_id="r", seq=1, step=0, created_at="t", approval_id="g", phase="request"
            )
        ).request_kind
        == "approval"
    )


def test_outcome_json() -> None:
    assert outcome_to_json(Succeeded(RunResultData(text="hi", memory_tainted=True))) == {
        "type": "success",
        "result": {"text": "hi", "memoryTainted": True},
    }
    assert outcome_to_json(Failed("rate_limit", "Slow down.")) == {
        "type": "error",
        "code": "rate_limit",
        "message": "Slow down.",
    }
    assert outcome_to_json(Cancelled()) == {"type": "cancelled"}
    interrupted = outcome_to_json(Interrupted((PendingInterrupt(id="i1"),)))
    assert interrupted["type"] == "interrupt"
    with pytest.raises(ValueError):
        Interrupted(())
    assert RunResultData.from_json({"text": "t", "extra": 1}) == RunResultData(
        text="t", extra={"extra": 1}
    )


@pytest.mark.parametrize(
    ("raw", "cursor"),
    [
        ("0", RunCursor(0)),
        ("42", RunCursor(42)),
        ("42.1", RunCursor(42, 1)),
        ("7.0", RunCursor(7, 0)),
    ],
)
def test_cursor_parse_and_format(raw: str, cursor: RunCursor) -> None:
    assert RunCursor.parse(raw) == cursor
    assert str(cursor) == raw


@pytest.mark.parametrize("raw", ["", "-1", "01", "1.", ".1", "1.2.3", "a", "1.01", "12345678901"])
def test_cursor_rejects_garbage(raw: str) -> None:
    with pytest.raises(ValueError):
        RunCursor.parse(raw)


def test_cursor_order_and_ids() -> None:
    ordered = [RunCursor(3), RunCursor(4, 0), RunCursor(4, 1), RunCursor(4), RunCursor(5, 0)]
    assert sorted(reversed(ordered), key=RunCursor.sort_key) == ordered
    assert RunCursor(4, 1) < RunCursor(4) and not RunCursor(4) < RunCursor(4, 1)
    assert [str(RunCursor.for_event(9, i, 3)) for i in range(3)] == ["9.0", "9.1", "9"]
    assert str(RunCursor.for_event(9, 0, 1)) == "9"
    # The wire pattern in openapi.yaml accepts every cursor we format.
    for c in ordered:
        models.RunGapEventValue.model_validate(
            {"after": str(c), "resumeAt": 1, "reason": "compacted"}
        )


# --- event log -------------------------------------------------------------------


async def test_event_log_append_is_idempotent_and_read_is_ordered() -> None:
    log = InMemoryRunEventLog()
    for seq in (2, 1, 3):
        assert await log.append(_tok("r", seq, f"t{seq}")) == seq
    assert await log.append(_tok("r", 2, "DIFFERENT")) == 2  # first write wins
    got = await log.read("r")
    assert [(e.seq, e.text) for e in got if isinstance(e, TokenEvent)] == [
        (1, "t1"),
        (2, "t2"),
        (3, "t3"),
    ]
    assert [e.seq for e in await log.read("r", after_seq=1, limit=1)] == [2]
    assert await log.read("unknown") == []
    assert await log.last_seq("r") == 3
    assert await log.last_seq("unknown") == 0
    with pytest.raises(ValueError):
        await log.append(_tok("r", 0))


async def test_event_log_subscribe_replays_then_follows_then_stops_on_seal() -> None:
    log = InMemoryRunEventLog(tick=0.01)
    await log.append(_tok("r", 1))
    await log.append(_tok("r", 2))
    seen: list[int] = []
    ticks = 0

    async def consume() -> None:
        nonlocal ticks
        async for batch in log.subscribe("r", after_seq=1):
            if not batch:
                ticks += 1
            seen.extend(e.seq for e in batch)

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.05)  # idle → empty tick batches
    await log.append(_tok("r", 3))
    await log.append(_tok("r", 4))
    await asyncio.sleep(0.02)
    await log.seal("r")
    await asyncio.wait_for(task, timeout=1)
    assert seen == [2, 3, 4]
    assert ticks >= 1
    with pytest.raises(RuntimeError):
        await log.append(_tok("r", 5))
    await log.seal("r")  # idempotent


async def test_event_log_subscriber_can_stop_early() -> None:
    log = InMemoryRunEventLog(tick=0.01)
    await log.append(_tok("r", 1))
    gen = log.subscribe("r")
    assert [e.seq for e in await anext(gen)] == [1]
    await gen.aclose()


async def test_event_log_compact_and_purge() -> None:
    log = InMemoryRunEventLog()
    for seq in range(1, 6):
        await log.append(_tok("r", seq))
    result = ResultEvent(run_id="r", seq=6, step=1, created_at="t", status="done")
    await log.append(result)
    snap = MessagesSnapshotEvent(
        run_id="r", seq=5, step=1, created_at="t", messages=({"id": "r:1", "role": "assistant"},)
    )
    assert await log.compact("r", snap) is True
    assert [e.kind for e in await log.read("r")] == ["messages_snapshot", "result"]
    assert await log.compact("r", snap) is False  # idempotent
    assert await log.last_seq("r") == 6
    with pytest.raises(SeqConflict):
        await log.compact("other", snap)
    await log.purge("r")
    assert await log.read("r") == [] and await log.last_seq("r") == 0


# --- emitter.emit --------------------------------------------------------------------


async def test_emitter_emit_stamps_progress_events_and_refuses_lifecycle_kinds() -> None:
    out: list[TaskEvent] = []

    async def sink(e: TaskEvent) -> None:
        out.append(e)

    em = RunEmitter(run_id="r", sink=sink, start_seq=4, start_step=2)
    await em.emit(SuggestionsEvent, values=("Why?",))
    await em.emit(ToolImageEvent, tool_call_id="tc", mode="t2i", images=())
    assert [(e.kind, e.seq, e.step, e.run_id) for e in out] == [
        ("suggestions", 5, 2, "r"),
        ("tool_image", 6, 2, "r"),
    ]
    for kind in (StatusEvent, ResultEvent, ApprovalEvent, MessagesSnapshotEvent):
        with pytest.raises(ValueError):
            await em.emit(kind)
    await em.result("done", memory_tainted=True, usage=(TokenUsage(input_tokens=1),))
    await em.emit(SuggestionsEvent, values=("late",))  # dropped after settle
    last = out[-1]
    assert isinstance(last, ResultEvent) and last.memory_tainted and last.seq == 7


# --- harness fake --------------------------------------------------------------------


async def test_scripted_harness_plays_script_and_honours_cancel() -> None:
    out: list[TaskEvent] = []

    async def sink(e: TaskEvent) -> None:
        out.append(e)

    inp = RunInput(run_id="r", thread_id="t", mode="interactive", user_id=None, messages=())
    harness = ScriptedHarness(
        [ScriptedHarness.say("think", channel="reasoning"), ScriptedHarness.say("hi")],
        result=HarnessResult(Succeeded(RunResultData(text="hi"))),
    )
    res = await harness.run(inp, RunEmitter(run_id="r", sink=sink), asyncio.Event())
    assert res.outcome == Succeeded(RunResultData(text="hi"))
    assert [e.kind for e in out] == ["step_start", "token", "step_end"] * 2
    assert harness.inputs == [inp]
    # The adapter never writes terminal entries itself.
    assert not any(e.kind in ("result", "status", "approval") for e in out)

    cancel = asyncio.Event()
    cancel.set()
    res = await ScriptedHarness([ScriptedHarness.say("x")]).run(
        inp, RunEmitter(run_id="r", sink=sink), cancel
    )
    assert isinstance(res.outcome, Cancelled)
    assert isinstance(Yielded("time_budget"), Yielded)


# --- encoder fake --------------------------------------------------------------------


async def test_recording_encoder_frames_a_run() -> None:
    repo = _repo()
    created = await repo.create(A, RunSpec(run_id=_rid(1), thread_id=THREAD, mode="interactive"))
    enc = RecordingEncoder(created.run)
    assert enc.start(created.run) == [{"type": "RUN_STARTED", "threadId": THREAD, "runId": _rid(1)}]
    assert enc.encode(_tok(_rid(1), 1))[0]["name"] == "test.token"
    with pytest.raises(ValueError):
        enc.finish(created.run)  # still running
    await repo.settle(_rid(1), Succeeded(RunResultData(text="done")))
    run = await repo.get(A, _rid(1))
    assert run is not None
    closing = enc.finish(run)
    assert closing[0]["type"] == "RUN_FINISHED" and closing[0]["result"] == {"text": "done"}


# --- repository fake -----------------------------------------------------------------


async def test_create_interactive_is_idempotent_and_conflicts_do_not_leak() -> None:
    clock = _Clock()
    repo = _repo(clock)
    spec = RunSpec(run_id=_rid(1), thread_id=THREAD, mode="interactive", lease_seconds=60)
    first = await repo.create(A, spec)
    assert first.created and first.run.status == "running"
    assert first.run.lease_expires_at == clock.now + timedelta(seconds=60)
    retry = await repo.create(
        A, RunSpec(run_id=_rid(1), thread_id=THREAD, mode="interactive", goal="ignored")
    )
    assert not retry.created and retry.run == first.run
    for owner, other in (
        (A, RunSpec(run_id=_rid(1), thread_id=CONV, mode="interactive")),  # other thread
        (
            A,
            RunSpec(
                run_id=_rid(1),
                thread_id=THREAD,
                mode="background",
                max_steps=5,
                checkpoint=BG_CHECKPOINT,
            ),
        ),
        (B, spec),  # another user
        (RunOwner.anonymous("tok"), spec),  # anonymous, no matching token
    ):
        with pytest.raises(RunIdConflict) as exc:
            await repo.create(owner, other)
        assert str(exc.value) == ""  # nothing about the existing run
    assert await repo.get(B, _rid(1)) is None


async def test_create_background_rules() -> None:
    repo = _repo()
    bg = RunSpec(
        run_id=_rid(2),
        thread_id=CONV,
        mode="background",
        goal="g",
        max_steps=7,
        checkpoint={**BG_CHECKPOINT, "seq": 99},
    )
    created = await repo.create(A, bg)
    assert created.run.status == "queued"
    assert repo.checkpoint_of(_rid(2)) == {
        "messages": [],
        "config": {"model": "m", "maxSteps": 7},
        "step": 0,
        "seq": 1,
    }
    with pytest.raises(ThreadNotFound):
        await repo.create(
            B,
            RunSpec(
                run_id=_rid(3),
                thread_id=CONV,
                mode="background",
                max_steps=5,
                checkpoint=BG_CHECKPOINT,
            ),
        )
    with pytest.raises(ValueError):
        await repo.create(
            A, RunSpec(run_id=_rid(4), thread_id=CONV, mode="background", checkpoint=BG_CHECKPOINT)
        )
    with pytest.raises(ValueError):
        await repo.create(
            A, RunSpec(run_id=_rid(5), thread_id=CONV, mode="background", max_steps=5)
        )
    with pytest.raises(ValueError):
        await repo.create(
            RunOwner.anonymous("t"),
            RunSpec(
                run_id=_rid(6),
                thread_id=CONV,
                mode="background",
                max_steps=5,
                checkpoint=BG_CHECKPOINT,
            ),
        )
    assert await repo.mark_running(_rid(2)) is True
    assert await repo.mark_running(_rid(2)) is False


async def test_create_resume_checks_previous_run() -> None:
    repo = _repo()
    await repo.create(A, RunSpec(run_id=_rid(1), thread_id=THREAD, mode="interactive"))
    with pytest.raises(PreviousRunNotFound):
        await repo.create(
            A, RunSpec(run_id=_rid(2), thread_id=CONV, mode="interactive", previous_run_id=_rid(1))
        )
    with pytest.raises(PreviousRunNotFound):
        await repo.create(
            B,
            RunSpec(run_id=_rid(3), thread_id=THREAD, mode="interactive", previous_run_id=_rid(1)),
        )
    ok = await repo.create(
        A, RunSpec(run_id=_rid(4), thread_id=THREAD, mode="interactive", previous_run_id=_rid(1))
    )
    assert ok.run.previous_run_id == _rid(1)


async def test_settle_and_cancel_transitions() -> None:
    repo = _repo()
    for n in range(1, 5):
        await repo.create(A, RunSpec(run_id=_rid(n), thread_id=THREAD, mode="interactive"))
    interrupt = PendingInterrupt(
        id="tc1", request_kind="approval", tool="webFetch", tool_call_id="tc1"
    )
    assert await repo.settle(_rid(1), Interrupted((interrupt,)))
    run = await repo.get(A, _rid(1))
    assert run is not None and run.status == "interrupted" and run.internal_status == "paused"
    assert run.open_interrupts == (interrupt.to_agui(),)
    assert repo.outcome_of(_rid(1)) == outcome_to_json(Interrupted((interrupt,)))
    assert await repo.settle(_rid(1), Succeeded()) is False  # interrupted is an end state

    assert await repo.settle(_rid(2), Failed("provider", "boom"))
    failed = await repo.get(A, _rid(2))
    assert failed is not None and failed.error == {"code": "provider", "message": "boom"}

    cancelled = await repo.cancel(A, _rid(1))  # interrupted → cancelled
    assert (
        cancelled is not None
        and cancelled.status == "cancelled"
        and cancelled.open_interrupts == ()
    )
    again = await repo.cancel(A, _rid(1))
    assert again is not None and again.status == "cancelled"
    assert (await repo.cancel(A, _rid(2))) == failed  # ended runs are left alone
    assert await repo.cancel(B, _rid(3)) is None  # not the owner's

    assert await repo.cancel(A, _rid(3)) is not None
    assert await repo.settle(_rid(3), Succeeded()) is False  # cancel won the race
    assert await repo.heartbeat(_rid(3)) is False  # executing process must stop
    assert await repo.heartbeat(_rid(4)) is True


async def test_reap_expired_fails_only_lapsed_interactive_runs() -> None:
    clock = _Clock()
    repo = _repo(clock)
    await repo.create(
        A, RunSpec(run_id=_rid(1), thread_id=THREAD, mode="interactive", lease_seconds=30)
    )
    await repo.create(
        A, RunSpec(run_id=_rid(2), thread_id=THREAD, mode="interactive", lease_seconds=300)
    )
    await repo.create(
        A,
        RunSpec(
            run_id=_rid(3), thread_id=CONV, mode="background", max_steps=5, checkpoint=BG_CHECKPOINT
        ),
    )
    clock.tick(60)
    reaped = await repo.reap_expired()
    assert [r.id for r in reaped] == [_rid(1)]
    assert reaped[0].error == {
        "code": "worker_lost",
        "message": InMemoryRunRepository.WORKER_LOST_MESSAGE,
    }
    assert await repo.reap_expired() == []


async def test_list_filters_and_pages() -> None:
    clock = _Clock()
    repo = _repo(clock)
    for n in range(1, 8):
        clock.tick()
        mode = "background" if n % 2 else "interactive"
        thread = CONV if mode == "background" else THREAD
        spec = RunSpec(
            run_id=_rid(n),
            thread_id=thread,
            mode=mode,
            max_steps=5 if mode == "background" else None,
            checkpoint=BG_CHECKPOINT if mode == "background" else None,
        )
        await repo.create(A, spec)
    await repo.create(B, RunSpec(run_id=_rid(99), thread_id=THREAD, mode="interactive"))
    await repo.settle(_rid(2), Succeeded())

    page = await repo.list_runs(A, RunFilter(), page_size=3)
    assert [r.id for r in page.runs] == [_rid(7), _rid(6), _rid(5)]
    ids = [r.id for r in page.runs]
    while page.next_page_token:
        page = await repo.list_runs(A, RunFilter(), page_size=3, page_token=page.next_page_token)
        ids += [r.id for r in page.runs]
    assert ids == [_rid(n) for n in range(7, 0, -1)]  # no repeats, no gaps, B's run absent

    bg = await repo.list_runs(A, RunFilter(mode="background"))
    assert {r.id for r in bg.runs} == {_rid(1), _rid(3), _rid(5), _rid(7)}
    done = await repo.list_runs(A, RunFilter(statuses=frozenset({"succeeded"})))
    assert [r.id for r in done.runs] == [_rid(2)]
    on_thread = await repo.list_runs(A, RunFilter(thread_id=THREAD))
    assert {r.id for r in on_thread.runs} == {_rid(2), _rid(4), _rid(6)}

    first = await repo.list_runs(A, RunFilter(), page_size=2)
    assert first.next_page_token is not None
    with pytest.raises(InvalidPageToken):  # token from other filters
        await repo.list_runs(A, RunFilter(mode="background"), page_token=first.next_page_token)
    with pytest.raises(InvalidPageToken):
        await repo.list_runs(A, RunFilter(), page_token="garbage!")
    with pytest.raises(ValueError):
        await repo.list_runs(A, RunFilter(), page_size=0)
    assert (await repo.list_runs(RunOwner.anonymous("t"), RunFilter())).runs == ()


async def test_anonymous_runs_are_scoped_to_their_token() -> None:
    repo = _repo()
    anon = RunOwner.anonymous("secret-token-0123456789ab")
    spec = RunSpec(run_id=_rid(1), thread_id=THREAD, mode="interactive")
    assert (await repo.create(anon, spec)).created
    assert not (await repo.create(anon, spec)).created  # same token → retry
    assert await repo.get(RunOwner.anonymous("other"), _rid(1)) is None
    assert await repo.get(A, _rid(1)) is None


async def test_run_to_contract_matches_the_contract_run_schema() -> None:
    repo = _repo()
    await repo.create(A, RunSpec(run_id=_rid(1), thread_id=THREAD, mode="interactive"))
    await repo.create(A, RunSpec(run_id=_rid(2), thread_id=THREAD, mode="interactive"))
    await repo.create(A, RunSpec(run_id=_rid(3), thread_id=THREAD, mode="interactive"))
    await repo.settle(_rid(1), Succeeded(RunResultData(text="hi", memory_tainted=True)))
    await repo.settle(_rid(2), Interrupted((PendingInterrupt(id="tc", prompt="ok?"),)))
    await repo.settle(_rid(3), Failed("provider", "boom"))
    for n, status in ((1, "succeeded"), (2, "interrupted"), (3, "failed")):
        run = await repo.get(A, _rid(n))
        assert run is not None
        body = run_to_contract(run, last_seq=12)
        parsed = models.Run.model_validate(body)
        assert parsed.status == status
        assert (body["result"] is not None) == (status == "succeeded")
        assert (body["error"] is not None) == (status == "failed")
        assert bool(body["openInterrupts"]) == (status == "interrupted")
    live = await repo.create(A, RunSpec(run_id=_rid(4), thread_id=THREAD, mode="interactive"))
    body = run_to_contract(live.run, last_seq=0)
    models.Run.model_validate(body)
    assert body["finishedAt"] is None and body["result"] is None
