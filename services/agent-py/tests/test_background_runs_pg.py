"""Background runs on `/v1/runs` against a real Postgres (wave 5b-A).

Opt-in like `test_runs_pg.py`: set `AGENT_PY_TEST_DB_URL` to a disposable
database with the Supabase migrations applied (through 0045). Skipped
otherwise; `bun run test:db` and the `agent-py-db` CI job set it.

* 0043 / 0045 — each question is answered once (Q41, Q58): a runs resume
  while a `respond` job holds it → `create_run` 55000 → `409
  run_already_answered`;
  a `respond` after a live resume → `enqueue_task_job` 55000.
* Q41 end to end — a background run pauses on `askUser` (the executor
  with a scripted step fn), its stream announces the question before
  `RUN_FINISHED` (`hummingbird.interrupt_pending`), a background resume
  starts from its checkpoint with the answer, the executor applies it
  and continues; the paused row stays `paused`.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import Iterator
from typing import Any

import asyncpg
import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import executor, store
from agent_py.main import create_app
from agent_py.runner import PendingInputDescriptor, RunStepContext, RunStepFn, RunStepOutcome
from agent_py.runs import wiring
from agent_py.runs.model import RunOwner
from agent_py.runs.repository import (
    PreviousRunAlreadyAnswered,
    PreviousRunNotWaiting,
    RunSpec,
)
from agent_py.runs.repository_pg import PgRunRepository
from agent_py.settings import Settings

DB_URL = os.environ.get("AGENT_PY_TEST_DB_URL", "")
pytestmark = pytest.mark.skipif(not DB_URL, reason="AGENT_PY_TEST_DB_URL not set")

SECRET = "pg-test-secret-do-not-use-in-prod-32b!"


def _id() -> str:
    return str(uuid.uuid4())


def _auth(sub: str) -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": sub,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 600,
        },
        SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


async def _connect() -> asyncpg.Connection:
    return await asyncpg.connect(DB_URL)


async def _seed() -> tuple[str, str]:
    conn = await _connect()
    try:
        user, ws, conv = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        await conn.execute(
            "INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', "
            "'authenticated', $2)",
            user,
            f"{user}@bg.test",
        )
        await conn.execute(
            "INSERT INTO public.workspaces (id, user_id, name) VALUES ($1, $2, 'ws')", ws, user
        )
        await conn.execute(
            "INSERT INTO public.conversations (id, user_id, workspace_id, title) "
            "VALUES ($1, $2, $3, 'c')",
            conv,
            user,
            ws,
        )
        return str(user), str(conv)
    finally:
        await conn.close()


async def _drop(user: str) -> None:
    conn = await _connect()
    try:
        await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user))
    finally:
        await conn.close()


@pytest.fixture
def seeded() -> Iterator[tuple[str, str]]:
    user, conv = asyncio.run(_seed())
    try:
        yield user, conv
    finally:
        asyncio.run(_drop(user))


ASK = {"prompt": "Which colour?"}


def _pause_on_ask(_p: Any, _c: Any, messages: list[Any], _ctx: Any = None) -> RunStepFn:
    async def step(_ctx: RunStepContext) -> RunStepOutcome:
        messages.append(
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "call-ask", "name": "askUser", "input": ASK}
                ],
            }
        )
        return RunStepOutcome(
            done=False,
            pending_input=PendingInputDescriptor(tool_call_id="call-ask", tool="askUser", args=ASK),
        )

    return step


class _Settle:
    def __init__(self) -> None:
        self.seen: list[list[dict[str, Any]]] = []

    def make(self, _p: Any, _c: Any, messages: list[Any], _ctx: Any = None) -> RunStepFn:
        async def step(_ctx: RunStepContext) -> RunStepOutcome:
            self.seen.append([dict(m) for m in messages])
            await _ctx.emitter.token("Painted it blue.")
            return RunStepOutcome(done=True)

        return step


async def _as_user_enqueue_respond(user: str, task_id: str) -> None:
    conn = await _connect()
    try:
        async with conn.transaction():
            await store._set_user_context(conn, user_id=user)
            await conn.fetchval(
                "SELECT public.enqueue_task_job($1, 'respond', $2::jsonb)",
                uuid.UUID(task_id),
                json.dumps({"requestId": "call-ask", "value": "red"}),
            )
    finally:
        await conn.close()


async def _status(task_id: str) -> str:
    conn = await _connect()
    try:
        return str(
            await conn.fetchval("SELECT status FROM public.tasks WHERE id = $1", uuid.UUID(task_id))
        )
    finally:
        await conn.close()


def _sse_events(text: str) -> list[dict[str, Any]]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in text.splitlines()
        if line.startswith("data: ")
    ]


def test_background_resume_end_to_end_and_answer_once(
    monkeypatch: pytest.MonkeyPatch, seeded: tuple[str, str]
) -> None:
    user, conv = seeded
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("WORKER_CHUNK_BUDGET_S", "0")
    app = create_app(enable_poller=False)
    with TestClient(app) as client:
        assert client.portal is not None
        pool = client.portal.call(lambda: asyncpg.create_pool(DB_URL, min_size=1, max_size=4))
        services = wiring.build_run_services(
            Settings(SUPABASE_JWT_SECRET=SECRET, RUNS_STUB_HARNESS=True), pool
        )
        app.dependency_overrides[wiring.get_run_services] = lambda: services
        headers = _auth(user)
        try:
            # Start: research, workspace, approvals, MCP allow-list.
            first = {
                "threadId": conv,
                "runId": _id(),
                "messages": [{"id": "m", "role": "user", "content": "Paint the fence"}],
                "forwardedProps": {
                    "mode": "background",
                    "research": True,
                    "workspaceId": "ws-x",
                    "requireApprovalFor": ["send"],
                    "allowedMcpServerIds": [],
                },
            }
            assert client.post("/v1/runs", json=first, headers=headers).status_code == 202
            run_id = first["runId"]

            async def load_cp(rid: str) -> dict[str, Any]:
                cp = await store.load_checkpoint(pool, run_id=rid, user_id=user)
                assert cp is not None
                return cp

            cfg = client.portal.call(load_cp, run_id)["config"]
            assert cfg["mode"] == "research" and cfg["maxSteps"] == 35
            assert cfg["workspaceId"] == "ws-x" and cfg["requireApprovalFor"] == ["send"]
            assert cfg["allowedMcpServerIds"] == []

            # The worker runs it until it asks.
            payload = executor.StartActionPayload(run_id=run_id, user_id=user)
            out = client.portal.call(
                lambda: executor.execute_start(pool, payload, make_step_fn=_pause_on_ask)
            )
            assert out.settled
            run = client.get(f"/v1/runs/{run_id}", headers=headers).json()
            assert run["status"] == "interrupted" and run["step"] == 1
            [interrupt] = run["openInterrupts"]
            assert interrupt["id"] == "call-ask" and interrupt["reason"] == "input"
            events = _sse_events(client.get(f"/v1/runs/{run_id}/events", headers=headers).text)
            names = [e.get("name") or e["type"] for e in events]
            pending = names.index("hummingbird.interrupt_pending")
            assert pending < names.index("RUN_FINISHED")
            assert events[pending]["value"] == interrupt

            # Resume through the runs API.
            resume = {
                "threadId": conv,
                "runId": _id(),
                "messages": first["messages"],
                "forwardedProps": {"mode": "background", "previousRunId": run_id},
                "resume": [
                    {"interruptId": "call-ask", "status": "resolved", "payload": {"value": "blue"}}
                ],
            }
            accepted = client.post("/v1/runs", json=resume, headers=headers)
            assert accepted.status_code == 202, accepted.text
            new_id = resume["runId"]

            # …so the old respond route can no longer answer it (0043).
            with pytest.raises(asyncpg.PostgresError) as refused:
                client.portal.call(_as_user_enqueue_respond, user, run_id)
            assert refused.value.sqlstate == "55000"

            # The worker applies the answer and continues.
            settle = _Settle()
            out = client.portal.call(
                lambda: executor.execute_start(
                    pool,
                    executor.StartActionPayload(run_id=new_id, user_id=user),
                    make_step_fn=settle.make,
                )
            )
            assert out.settled
            last = settle.seen[0][-1]
            assert last["role"] == "user"
            assert last["content"] == [
                {"type": "tool_result", "tool_use_id": "call-ask", "content": "blue"}
            ]
            done = client.get(f"/v1/runs/{new_id}", headers=headers).json()
            assert done["status"] == "succeeded" and done["previousRunId"] == run_id
            assert done["step"] == 2
            assert client.portal.call(_status, run_id) == "paused"
            stream = _sse_events(client.get(f"/v1/runs/{new_id}/events", headers=headers).text)
            results = [e for e in stream if e["type"] == "TOOL_CALL_RESULT"]
            assert results and results[0]["toolCallId"] == "call-ask"
        finally:
            client.portal.call(pool.close)


async def _paused_task(pool: asyncpg.Pool, user: str, conv: str) -> str:
    repo = PgRunRepository(pool)
    run_id = _id()
    await repo.create(
        RunOwner.user(user),
        RunSpec(
            run_id=run_id,
            thread_id=conv,
            mode="background",
            goal="g",
            max_steps=3,
            checkpoint={"messages": [{"role": "user", "content": "hi"}], "config": {}},
        ),
    )
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE public.tasks SET status = 'paused', outcome = $2::jsonb WHERE id = $1",
            uuid.UUID(run_id),
            json.dumps({"type": "interrupt", "interrupts": [{"id": "call-ask"}]}),
        )
    return run_id


ANSWERS: dict[str, object] = {
    "messages": [],
    "config": {},
    "resume": {"answers": [{"interruptId": "call-ask", "status": "cancelled"}]},
}


def test_respond_first_then_runs_resume_is_refused(seeded: tuple[str, str]) -> None:
    user, conv = seeded

    async def go() -> None:
        pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=4)
        try:
            task = await _paused_task(pool, user, conv)
            await _as_user_enqueue_respond(user, task)
            with pytest.raises(PreviousRunAlreadyAnswered):
                await PgRunRepository(pool).create(
                    RunOwner.user(user),
                    RunSpec(
                        run_id=_id(),
                        thread_id=conv,
                        mode="background",
                        goal="g",
                        max_steps=3,
                        previous_run_id=task,
                        checkpoint=ANSWERS,
                    ),
                )
            # An interactive resume of it is refused too: another mode (B11).
            with pytest.raises(PreviousRunNotWaiting):
                await PgRunRepository(pool).create(
                    RunOwner.user(user),
                    RunSpec(run_id=_id(), thread_id=conv, mode="interactive", previous_run_id=task),
                )
        finally:
            await pool.close()

    asyncio.run(go())


def test_runs_resume_then_respond_is_refused_until_the_resume_fails(
    seeded: tuple[str, str],
) -> None:
    user, conv = seeded

    async def go() -> None:
        pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=4)
        try:
            task = await _paused_task(pool, user, conv)
            repo = PgRunRepository(pool)
            resume = await repo.create(
                RunOwner.user(user),
                RunSpec(
                    run_id=_id(),
                    thread_id=conv,
                    mode="background",
                    goal="g",
                    max_steps=3,
                    previous_run_id=task,
                    checkpoint=ANSWERS,
                ),
            )
            with pytest.raises(asyncpg.PostgresError) as refused:
                await _as_user_enqueue_respond(user, task)
            assert refused.value.sqlstate == "55000"
            assert "already answered" in str(refused.value)
            # A resume that failed before applying its answers frees the
            # question (Q57; as it frees 0042's slot).
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE public.tasks SET status = 'failed' WHERE id = $1",
                    uuid.UUID(resume.run.id),
                )
            await _as_user_enqueue_respond(user, task)
        finally:
            await pool.close()

    asyncio.run(go())


def test_route_maps_already_answered_to_409(
    monkeypatch: pytest.MonkeyPatch, seeded: tuple[str, str]
) -> None:
    user, conv = seeded
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    app = create_app(enable_poller=False)
    with TestClient(app) as client:
        assert client.portal is not None
        pool = client.portal.call(lambda: asyncpg.create_pool(DB_URL, min_size=1, max_size=4))
        services = wiring.build_run_services(
            Settings(SUPABASE_JWT_SECRET=SECRET, RUNS_STUB_HARNESS=True), pool
        )
        app.dependency_overrides[wiring.get_run_services] = lambda: services
        try:
            # A paused background run with an open question, answered the old way.
            first = {
                "threadId": conv,
                "runId": _id(),
                "messages": [{"id": "m", "role": "user", "content": "Paint"}],
                "forwardedProps": {"mode": "background"},
            }
            assert client.post("/v1/runs", json=first, headers=_auth(user)).status_code == 202
            payload = executor.StartActionPayload(run_id=first["runId"], user_id=user)
            client.portal.call(
                lambda: executor.execute_start(pool, payload, make_step_fn=_pause_on_ask)
            )
            client.portal.call(_as_user_enqueue_respond, user, first["runId"])
            r = client.post(
                "/v1/runs",
                json={
                    **first,
                    "runId": _id(),
                    "forwardedProps": {"mode": "background", "previousRunId": first["runId"]},
                    "resume": [{"interruptId": "call-ask", "status": "cancelled"}],
                },
                headers=_auth(user),
            )
            assert r.status_code == 409 and r.json()["code"] == "run_already_answered"
        finally:
            client.portal.call(pool.close)
