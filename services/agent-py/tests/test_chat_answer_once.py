"""Q63 — chat on runs answers a question once (Q57 for interactive runs).

An interactive resume (a new run with `previousRunId` + `resume[]`) that
applied its answers — an approved tool ran — and then ended (a model
error, a Stop, the process dying) must not free the question: a second
answer would start from the paused run's checkpoint and run the approved
tool again. It is `409 run_answer_applied` instead. A resume that ended
*before* applying still frees it.

Through `POST /v1/runs` with the native harness (scripted model, one
gated side-effecting tool), on both stores:

* `postgres` — a signed-in caller, runs as `tasks` rows (`create_run`,
  0046); needs `AGENT_PY_TEST_DB_URL` (`bun run test:db`);
* `memory` — an anonymous caller (run token), the in-memory store.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import asyncpg
import httpx
import jwt
import pytest
import pytest_asyncio

from agent_py import db as db_module
from agent_py.main import create_app
from agent_py.runs import wiring
from agent_py.runs.access import RUN_TOKEN_HEADER
from agent_py.runs.harness import RunInput
from agent_py.runs.native_harness import Toolset, build_native_harness
from agent_py.settings import Settings
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

from .task_world import DB_URL, seed_user

pytestmark = pytest.mark.asyncio

SECRET = "chat-answer-once-secret-do-not-use-32b!"
MODEL = "anthropic/claude-haiku-4.5"
SEND = "send"
"""Side-effecting and gated: the run pauses for approval before it runs."""


# --- the scripted model ----------------------------------------------------------


@dataclass
class Turn:
    blocks: list[dict[str, Any]]
    boom: bool = False
    """The stream raises (a provider failure) instead of answering."""


class _Stream:
    def __init__(self, turn: Turn) -> None:
        self._turn = turn

    async def __aenter__(self) -> _Stream:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    def __aiter__(self) -> Any:
        return self._events()

    async def _events(self) -> Any:
        yield SimpleNamespace(
            type="message_start", message=SimpleNamespace(usage=SimpleNamespace(input_tokens=3))
        )
        if self._turn.boom:
            raise RuntimeError("model stream broke")
        for block in self._turn.blocks:
            if block["type"] == "text":
                yield SimpleNamespace(
                    type="content_block_delta",
                    delta=SimpleNamespace(type="text_delta", text=block["text"]),
                )
        yield SimpleNamespace(type="message_delta", usage=SimpleNamespace(output_tokens=2))

    async def get_final_message(self) -> dict[str, Any]:
        tools = any(b["type"] == "tool_use" for b in self._turn.blocks)
        return {"content": self._turn.blocks, "stop_reason": "tool_use" if tools else "end_turn"}


class ScriptedModel:
    """Answers by how many assistant turns the history holds; each index
    plays its replies in order, then "ok"."""

    def __init__(self) -> None:
        self.script: dict[int, list[Turn]] = {}
        self.calls = 0
        self.messages = self

    def stream(self, **kwargs: Any) -> _Stream:
        self.calls += 1
        turns = sum(1 for m in kwargs["messages"] if m["role"] == "assistant")
        queue = self.script.get(turns, [])
        turn = queue.pop(0) if queue else Turn([{"type": "text", "text": "ok"}])
        return _Stream(turn)


def use_send(call_id: str = "q") -> Turn:
    return Turn([{"type": "tool_use", "id": call_id, "name": SEND, "input": {"to": "bob"}}])


# --- the world ---------------------------------------------------------------------


@dataclass
class ChatWorld:
    backend: str
    http: httpx.AsyncClient
    services: wiring.RunServices
    thread: str
    user: str | None
    pool: Any = None
    model: ScriptedModel = field(default_factory=ScriptedModel)
    effects: list[str] = field(default_factory=list)
    on_effect: Callable[[], Awaitable[None]] | None = None
    tokens: dict[str, str] = field(default_factory=dict)

    async def toolset(self, _run_input: RunInput) -> Toolset:
        async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
            self.effects.append(SEND)
            if self.on_effect is not None:
                await self.on_effect()
            return ToolInvocationResult(text="sent", summary="sent")

        tool = ToolDescriptor(
            name=SEND,
            description=SEND,
            input_schema={"type": "object"},
            execute=execute,
            side_effecting=True,
        )
        return Toolset(tools={SEND: tool}, gated=frozenset({SEND}))

    def headers(self, run_id: str | None = None) -> dict[str, str]:
        if self.user is None:
            token = self.tokens.get(run_id or "")
            return {RUN_TOKEN_HEADER: token} if token else {}
        claims = {
            "sub": self.user,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 600,
        }
        return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}

    async def post(
        self,
        *,
        previous: str | None = None,
        answer: dict[str, Any] | None = None,
        run_id: str | None = None,
    ) -> tuple[httpx.Response, str]:
        run_id = run_id or str(uuid.uuid4())
        props: dict[str, Any] = {"model": MODEL}
        body: dict[str, Any] = {
            "threadId": self.thread,
            "runId": run_id,
            "messages": [{"id": "u1", "role": "user", "content": "Send it"}],
            "forwardedProps": props,
        }
        if previous is not None:
            # An anonymous resume stays under the paused run's token.
            if previous in self.tokens:
                self.tokens[run_id] = self.tokens[previous]
            props["previousRunId"] = previous
            body["resume"] = [{"interruptId": "q", "status": "resolved", "payload": answer}]
        response = await self.http.post("/v1/runs", json=body, headers=self.headers(previous))
        token = response.headers.get(RUN_TOKEN_HEADER)
        if token:
            self.tokens[run_id] = token
        return response, run_id

    async def start(self) -> str:
        """A turn that pauses on the approval of `send`."""
        self.model.script[0] = [use_send()]
        response, run_id = await self.post()
        assert response.status_code == 200, response.text
        assert await self.status(run_id) == "interrupted"
        return run_id

    async def resume(
        self, previous: str, *, approved: bool = True, run_id: str | None = None
    ) -> tuple[httpx.Response, str]:
        return await self.post(previous=previous, answer={"approved": approved}, run_id=run_id)

    async def run(self, run_id: str) -> dict[str, Any]:
        response = await self.http.get(f"/v1/runs/{run_id}", headers=self.headers(run_id))
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        return body

    async def status(self, run_id: str) -> str:
        return str((await self.run(run_id))["status"])

    async def cancel(self, run_id: str) -> None:
        response = await self.http.post(f"/v1/runs/{run_id}/cancel", headers=self.headers(run_id))
        assert response.status_code == 200, response.text

    async def expire_and_reap(self, run_id: str) -> None:
        """The process executing `run_id` is gone: its lease lapses and the
        reaper fails it (`worker_lost`)."""
        if self.backend == "postgres":
            async with self.pool.acquire() as conn:
                await conn.execute(
                    "UPDATE public.tasks SET lease_expires_at = now() - interval '1 second' "
                    "WHERE id = $1",
                    uuid.UUID(run_id),
                )
        else:
            row = self.services.memory_repo._rows[run_id]
            past = datetime.now(UTC) - timedelta(seconds=1)
            row.record = replace(row.record, lease_expires_at=past)
        await self.services.maintain()

    def count(self) -> int:
        return self.effects.count(SEND)


BACKENDS = [
    "memory",
    pytest.param(
        "postgres", marks=pytest.mark.skipif(not DB_URL, reason="AGENT_PY_TEST_DB_URL not set")
    ),
]


@pytest_asyncio.fixture(params=BACKENDS)
async def world(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[ChatWorld]:
    backend = str(request.param)
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    settings = Settings(
        SUPABASE_JWT_SECRET=SECRET,
        RUNS_STUB_HARNESS=False,
        RUNS_RATE_PER_MINUTE=100_000,
        RUNS_ANONYMOUS_RATE_PER_MINUTE=100_000,
        RUNS_ANONYMOUS_MAX_CONCURRENT=100,
        RUNS_HEARTBEAT_SECONDS=30,
    )
    pool = None
    user: str | None = None
    thread = str(uuid.uuid4())
    if backend == "postgres":
        pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=8)
        async with pool.acquire() as conn:
            user, _workspace, thread = await seed_user(conn)
        db_module._pool = pool
    holder: dict[str, ChatWorld] = {}

    async def toolset(run_input: RunInput) -> Toolset:
        return await holder["world"].toolset(run_input)

    model = ScriptedModel()
    harness = build_native_harness(settings, client=model, build_tools=toolset, suggestions=False)  # type: ignore[arg-type]
    services = wiring.build_run_services(settings, pool, harness=harness)
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent")
    w = ChatWorld(backend, http, services, thread, user, pool, model=model)
    holder["world"] = w
    try:
        yield w
    finally:
        await services.driver.shutdown(grace_s=2)
        await http.aclose()
        if pool is not None:
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(str(user)))
            db_module._pool = None
            await pool.close()


def applied_refusal(response: httpx.Response) -> None:
    assert response.status_code == 409, "the approved tool could run again: " + response.text
    assert response.json()["code"] == "run_answer_applied", response.text


# --- the three ways an applied resume ends -------------------------------------------


async def test_a_resume_that_failed_after_the_tool_ran_never_reopens_the_question(
    world: ChatWorld,
) -> None:
    paused = await world.start()
    world.model.script[1] = [Turn([], boom=True)]
    response, resume = await world.resume(paused)
    assert response.status_code == 200
    assert await world.status(resume) == "failed" and world.count() == 1

    again, second = await world.resume(paused)
    assert world.count() == 1, "the approved tool ran twice"
    applied_refusal(again)
    # Nothing was created, and the paused run stays as it is (Q64).
    assert await world.status(paused) == "interrupted"
    missing = await world.http.get(f"/v1/runs/{second}", headers=world.headers(paused))
    assert missing.status_code == 404


async def test_a_resume_stopped_after_the_tool_ran_never_reopens_the_question(
    world: ChatWorld,
) -> None:
    paused = await world.start()
    resume = str(uuid.uuid4())

    async def stop() -> None:
        await world.cancel(resume)

    world.on_effect = stop
    response, _ = await world.resume(paused, run_id=resume)
    world.on_effect = None
    assert response.status_code == 200
    assert await world.status(resume) == "cancelled" and world.count() == 1

    again, _ = await world.resume(paused)
    assert world.count() == 1, "the approved tool ran twice"
    applied_refusal(again)


async def test_a_resume_whose_process_died_after_the_tool_ran_never_reopens_the_question(
    world: ChatWorld,
) -> None:
    class Died(BaseException):
        """The process is gone: nothing after this point runs."""

    paused = await world.start()
    resume = str(uuid.uuid4())
    effect = asyncio.Event()

    async def die() -> None:
        effect.set()
        raise Died

    world.on_effect = die
    post = asyncio.create_task(world.resume(paused, run_id=resume))
    await asyncio.wait_for(effect.wait(), timeout=10)
    world.on_effect = None
    for _ in range(100):  # the driver's task ends with `Died`, the row stays live
        if not world.services.driver.is_local(resume):
            break
        await asyncio.sleep(0.01)
    await world.expire_and_reap(resume)
    response, _ = await asyncio.wait_for(post, timeout=10)
    assert response.status_code == 200
    assert (await world.run(resume))["error"]["code"] == "worker_lost"
    assert world.count() == 1

    again, _ = await world.resume(paused)
    assert world.count() == 1, "the approved tool ran twice"
    applied_refusal(again)


# --- what must keep working ---------------------------------------------------------


async def test_a_resume_that_failed_before_applying_frees_the_question(world: ChatWorld) -> None:
    paused = await world.start()
    # No model client for this resume: it fails before any answer is applied.
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(world.services.harness, "_client", None)
        mp.setattr(world.services.harness, "_client_factory", lambda: None)
        response, first = await world.resume(paused)
    assert response.status_code == 200
    assert await world.status(first) == "failed" and world.count() == 0

    again, second = await world.resume(paused)
    assert again.status_code == 200, again.text
    assert await world.status(second) == "succeeded" and world.count() == 1


async def test_a_resume_stopped_before_applying_frees_the_question(world: ChatWorld) -> None:
    paused = await world.start()
    first = str(uuid.uuid4())
    driver = world.services.driver
    real_start = driver.start

    def start_stopped(**kw: Any) -> Any:
        # Stop reaches the run before its harness applies anything.
        task = real_start(**kw)
        driver.signal_cancel(first)
        return task

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(driver, "start", start_stopped)
        response, _ = await world.resume(paused, run_id=first)
    assert response.status_code == 200
    assert await world.status(first) == "cancelled" and world.count() == 0

    again, second = await world.resume(paused)
    assert again.status_code == 200, again.text
    assert await world.status(second) == "succeeded" and world.count() == 1


async def test_a_live_resume_is_still_run_already_resumed(world: ChatWorld) -> None:
    paused = await world.start()
    gate = asyncio.Event()
    reached = asyncio.Event()

    async def hold() -> None:
        reached.set()
        await gate.wait()

    world.on_effect = hold
    post = asyncio.create_task(world.resume(paused))
    await asyncio.wait_for(reached.wait(), timeout=10)
    again, _ = await world.resume(paused)
    assert again.status_code == 409 and again.json()["code"] == "run_already_resumed"
    gate.set()
    response, resume = await asyncio.wait_for(post, timeout=10)
    assert response.status_code == 200 and await world.status(resume) == "succeeded"
    assert world.count() == 1


async def test_racing_resumes_run_the_tool_once(world: ChatWorld) -> None:
    paused = await world.start()
    results = await asyncio.gather(*(world.resume(paused) for _ in range(4)))
    codes = sorted(r.status_code for r, _ in results)
    assert codes == [200, 409, 409, 409], [r.text for r, _ in results]
    for response, _ in results:
        if response.status_code == 409:
            assert response.json()["code"] == "run_already_resumed"
    assert world.count() == 1


# --- around the stamp: every await between "applied" and the tool --------------------


class Died(BaseException):
    """The process is gone: nothing after this point runs."""


def stamp_hook(
    world: ChatWorld,
    *,
    before: Callable[[], Awaitable[None]] | None = None,
    after: Callable[[], Awaitable[None]] | None = None,
) -> None:
    """Wrap the store's `mark_answers_applied` (the stamp) with code that
    runs just before / just after it."""
    repo = world.services.pg_repo if world.backend == "postgres" else world.services.memory_repo
    assert repo is not None
    real = repo.mark_answers_applied

    async def mark(run_id: str) -> bool:
        if before is not None:
            await before()
        ok = await real(run_id)
        if after is not None:
            await after()
        return ok

    repo.mark_answers_applied = mark  # type: ignore[method-assign]


async def _wait_until_not_local(world: ChatWorld, run_id: str) -> None:
    for _ in range(200):
        if not world.services.driver.is_local(run_id):
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the run is still executing")


async def test_a_stop_right_after_the_stamp_runs_nothing_and_keeps_the_question_closed(
    world: ChatWorld,
) -> None:
    paused = await world.start()
    resume = str(uuid.uuid4())

    async def stop() -> None:
        await world.cancel(resume)

    stamp_hook(world, after=stop)
    response, _ = await world.resume(paused, run_id=resume)
    assert response.status_code == 200
    assert await world.status(resume) == "cancelled" and world.count() == 0
    applied_refusal((await world.resume(paused))[0])
    assert world.count() == 0


@pytest.mark.parametrize("where", ["after the stamp", "logging the answer step"])
async def test_a_crash_after_the_stamp_keeps_the_question_closed(
    world: ChatWorld, where: str
) -> None:
    paused = await world.start()
    resume = str(uuid.uuid4())

    async def die() -> None:
        raise Died

    if where == "after the stamp":
        stamp_hook(world, after=die)
    else:
        log = world.services.log_for(
            world.services.memory_repo._rows[paused].record.owner
            if world.backend == "memory"
            else _owner(world)
        )
        real_append = log.append

        async def append(event: Any) -> int:
            if event.run_id == resume and event.kind == "step_start":
                raise Died
            return await real_append(event)

        log.append = append  # type: ignore[method-assign]
    post = asyncio.create_task(world.resume(paused, run_id=resume))
    await asyncio.sleep(0.05)
    await _wait_until_not_local(world, resume)
    if where != "after the stamp":
        log.append = real_append  # type: ignore[method-assign]
    await world.expire_and_reap(resume)
    response, _ = await asyncio.wait_for(post, timeout=10)
    assert response.status_code == 200
    assert (await world.run(resume))["status"] == "failed" and world.count() == 0
    applied_refusal((await world.resume(paused))[0])
    assert world.count() == 0


def _owner(world: ChatWorld) -> Any:
    from agent_py.runs.model import RunOwner

    assert world.user is not None
    return RunOwner.user(world.user)


async def test_a_stamp_whose_reply_was_lost_counts_as_applied(world: ChatWorld) -> None:
    paused = await world.start()

    async def lost() -> None:
        raise ConnectionError("connection reset after the commit")

    stamp_hook(world, after=lost)
    response, resume = await world.resume(paused)
    assert response.status_code == 200
    run = await world.run(resume)
    assert run["status"] == "failed" and world.count() == 0
    applied_refusal((await world.resume(paused))[0])


async def test_a_stamp_that_was_never_written_frees_the_question(world: ChatWorld) -> None:
    paused = await world.start()
    calls = 0

    async def down() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ConnectionError("database unreachable")

    stamp_hook(world, before=down)
    response, first = await world.resume(paused)
    assert response.status_code == 200
    assert await world.status(first) == "failed" and world.count() == 0
    again, second = await world.resume(paused)
    assert again.status_code == 200, again.text
    assert await world.status(second) == "succeeded" and world.count() == 1


async def test_a_stop_that_beat_the_stamp_frees_the_question(world: ChatWorld) -> None:
    paused = await world.start()
    first = str(uuid.uuid4())
    stopped = False

    async def stop_first() -> None:
        nonlocal stopped
        if not stopped:
            stopped = True
            await world.cancel(first)

    stamp_hook(world, before=stop_first)
    response, _ = await world.resume(paused, run_id=first)
    assert response.status_code == 200
    assert await world.status(first) == "cancelled" and world.count() == 0
    again, second = await world.resume(paused)
    assert again.status_code == 200, again.text
    assert await world.status(second) == "succeeded" and world.count() == 1


async def test_racing_answers_after_an_applied_failure_are_all_refused(world: ChatWorld) -> None:
    paused = await world.start()
    world.model.script[1] = [Turn([], boom=True)]
    response, resume = await world.resume(paused)
    assert response.status_code == 200 and await world.status(resume) == "failed"
    results = await asyncio.gather(*(world.resume(paused) for _ in range(4)))
    for again, _ in results:
        applied_refusal(again)
    assert world.count() == 1


@pytest.mark.skipif(not DB_URL, reason="AGENT_PY_TEST_DB_URL not set")
async def test_the_stamp_waits_for_a_resume_being_created(world: ChatWorld) -> None:
    """`create_run` checks for an applied resume and inserts under the
    user's task lock; the stamp takes it too, so it can't land between."""
    if world.backend != "postgres":
        pytest.skip("Postgres only")
    from agent_py.runs.repository import RunSpec

    paused = await world.start()
    repo = world.services.pg_repo
    assert repo is not None and world.user is not None
    live = str(uuid.uuid4())
    await repo.create(
        _owner(world),
        RunSpec(run_id=live, thread_id=world.thread, mode="interactive", previous_run_id=paused),
    )
    async with world.pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        await conn.execute("SELECT private.lock_user_tasks($1)", uuid.UUID(world.user))
        stamp = asyncio.create_task(repo.mark_answers_applied(live))
        await asyncio.sleep(0.3)
        assert not stamp.done(), "the stamp did not wait for the user's task lock"
        await tx.commit()
    assert await asyncio.wait_for(stamp, timeout=5) is True


# --- the stub harness (conformance, e2e) ---------------------------------------------


@pytest.mark.parametrize(
    ("steering", "applied", "status"),
    [
        ({}, True, "succeeded"),
        ({"outcome": "fail"}, True, "failed"),
        ({"outcome": "fail", "failBeforeApplying": True}, False, "failed"),
    ],
)
async def test_the_stub_applies_a_resume_unless_told_to_fail_before(
    steering: dict[str, Any], applied: bool, status: str
) -> None:
    from agent_py.emitter import RunEmitter
    from agent_py.runs.harness import ResumeAnswer
    from agent_py.runs.model import Failed, Succeeded
    from agent_py.runs.stub_harness import StubHarness

    calls: list[str] = []

    async def apply_answers() -> bool:
        calls.append("applied")
        return True

    async def sink(_event: Any) -> None:
        return None

    run_input = RunInput(
        run_id="r2",
        thread_id="t",
        mode="interactive",
        user_id=None,
        messages=(),
        options={"conformance": steering},
        resume=(ResumeAnswer("r1:approve", "resolved", {"approved": True}),),
        previous_run_id="r1",
        apply_answers=apply_answers,
    )
    result = await StubHarness().run(run_input, RunEmitter(run_id="r2", sink=sink), asyncio.Event())
    assert calls == (["applied"] if applied else [])
    expected = Succeeded if status == "succeeded" else Failed
    assert isinstance(result.outcome, expected)
