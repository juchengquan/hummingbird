"""Ephemeral runs (`forwardedProps.ephemeral`, contract 0.8.0, Q135/Q136).

The Explain-selection popover runs as an interactive run on a temporary
thread that no conversation owns. Signed in, a run is a `tasks` row —
one nobody would ever delete — so an ephemeral run lives in the in-memory
store and log, as an anonymous run does, while still being the signed-in
user's (their bearer reads it; their limits apply). It offers no tools:
not the skills, MCP, client tools or `askUser` / `renderUI` a client
sends, so it never runs a tool and never pauses on a question.

* the router: memory store for a signed-in caller even with a database;
  readable / cancellable with the bearer; never listed; refused for a
  background run or a resume;
* the native harness: no tools reach the model, no suggestions call.
"""

from __future__ import annotations

import dataclasses
import json
import time
import uuid
from collections.abc import Iterator
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py.emitter import RunEmitter
from agent_py.events import TaskEvent
from agent_py.main import create_app
from agent_py.runs import wiring
from agent_py.runs.event_log import InMemoryRunEventLog
from agent_py.runs.model import RunOwner, Succeeded
from agent_py.runs.native_harness import build_native_harness
from agent_py.runs.options import parse_run_options
from agent_py.runs.repository import InMemoryRunRepository
from agent_py.runs.wiring import RunServices, build_run_services
from agent_py.settings import Settings

from .test_native_harness import _Call, _Model, run_input, text, tool, toolset, usage

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER = "00000000-0000-4000-8000-000000000321"
OWNER = RunOwner.user(USER)


def _auth(sub: str = USER) -> dict[str, str]:
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


class FakePgRepo(InMemoryRunRepository):
    """The Postgres store as far as the router can tell."""

    def __init__(self) -> None:
        super().__init__(conversations={})

    async def exists(self, run_id: str) -> bool:
        return run_id in self._rows

    def contains_any(self) -> bool:
        return bool(self._rows)


@pytest.fixture
def repo() -> FakePgRepo:
    return FakePgRepo()


@pytest.fixture
def services(monkeypatch: pytest.MonkeyPatch, repo: FakePgRepo) -> RunServices:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    settings = Settings(
        SUPABASE_JWT_SECRET=SECRET,
        RUNS_STUB_HARNESS=True,
        RUNS_RATE_PER_MINUTE=1000,
        RUNS_ANONYMOUS_RATE_PER_MINUTE=1000,
    )
    return dataclasses.replace(
        build_run_services(settings, None),
        pg_repo=repo,  # type: ignore[arg-type]
        pg_log=InMemoryRunEventLog(),
    )


@pytest.fixture
def client(services: RunServices) -> Iterator[TestClient]:
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    with TestClient(app) as c:
        yield c


def _body(fp: dict[str, Any] | None = None, **kw: Any) -> dict[str, Any]:
    return {
        "threadId": kw.pop("threadId", str(uuid.uuid4())),
        "runId": kw.pop("runId", str(uuid.uuid4())),
        "messages": [{"id": "m1", "role": "user", "content": "Explain this"}],
        "forwardedProps": {"ephemeral": True, **(fp or {})},
        **kw,
    }


def _events(raw: str) -> list[dict[str, Any]]:
    return [
        json.loads(line[5:])
        for line in raw.splitlines()
        if line.startswith("data:") and line[5:].strip()
    ]


# --- the router ------------------------------------------------------------------------


def test_signed_in_ephemeral_run_lives_in_memory_never_in_tasks(
    client: TestClient, services: RunServices, repo: FakePgRepo
) -> None:
    body = _body()
    res = client.post("/v1/runs", json=body, headers=_auth())
    assert res.status_code == 200, res.text
    types = [e["type"] for e in _events(res.text)]
    assert types[0] == "RUN_STARTED" and types[-1] == "RUN_FINISHED"
    # Never a `tasks` row: the Postgres store saw nothing.
    assert not repo.contains_any()
    assert services.memory_repo.contains(body["runId"])
    # A signed-in run token is never minted: the bearer is the credential.
    assert "X-Run-Token" not in res.headers


def test_signed_in_ephemeral_run_is_read_and_cancelled_with_the_bearer(
    client: TestClient,
) -> None:
    body = _body({"conformance": {"steps": 2}})
    run_id = body["runId"]
    assert client.post("/v1/runs", json=body, headers=_auth()).status_code == 200
    got = client.get(f"/v1/runs/{run_id}", headers=_auth())
    assert got.status_code == 200, got.text
    assert got.json()["id"] == run_id and got.json()["status"] == "succeeded"
    events = client.get(f"/v1/runs/{run_id}/events?after=0", headers=_auth())
    assert events.status_code == 200
    assert _events(events.text)[-1]["type"] == "RUN_FINISHED"
    cancelled = client.post(f"/v1/runs/{run_id}/cancel", headers=_auth())
    assert cancelled.status_code == 200, cancelled.text
    # Someone else's bearer: the same 404 as a missing run.
    other = _auth("00000000-0000-4000-8000-000000000999")
    assert client.get(f"/v1/runs/{run_id}", headers=other).status_code == 404


def test_ephemeral_run_is_never_listed(client: TestClient) -> None:
    body = _body()
    assert client.post("/v1/runs", json=body, headers=_auth()).status_code == 200
    listed = client.get("/v1/runs", params={"threadId": body["threadId"]}, headers=_auth())
    assert listed.status_code == 200
    assert listed.json()["runs"] == []


def test_ephemeral_retry_replays_the_same_run(client: TestClient, repo: FakePgRepo) -> None:
    body = _body()
    first = client.post("/v1/runs", json=body, headers=_auth())
    again = client.post("/v1/runs", json=body, headers=_auth())
    assert first.status_code == again.status_code == 200
    assert _events(again.text)[-1]["type"] == "RUN_FINISHED"
    assert not repo.contains_any()


def test_ephemeral_run_id_taken_in_tasks_is_a_conflict(
    client: TestClient, repo: FakePgRepo
) -> None:
    taken = _body(fp={"ephemeral": False})
    del taken["forwardedProps"]["ephemeral"]
    assert client.post("/v1/runs", json=taken, headers=_auth()).status_code == 200
    assert repo.contains_any()
    clash = _body(runId=taken["runId"], threadId=taken["threadId"])
    res = client.post("/v1/runs", json=clash, headers=_auth())
    assert res.status_code == 409 and res.json()["code"] == "run_id_conflict"


def test_anonymous_ephemeral_run_is_an_anonymous_run(client: TestClient) -> None:
    res = client.post("/v1/runs", json=_body())
    assert res.status_code == 200
    assert res.headers.get("X-Run-Token")


@pytest.mark.parametrize(
    "fp",
    [{"mode": "background"}, {"previousRunId": str(uuid.uuid4())}],
    ids=["background", "resume"],
)
def test_ephemeral_background_or_resume_is_refused(
    client: TestClient, repo: FakePgRepo, fp: dict[str, Any]
) -> None:
    body = _body(fp)
    if "previousRunId" in fp:
        body["resume"] = [{"interruptId": "i1", "status": "resolved", "payload": {}}]
    res = client.post("/v1/runs", json=body, headers=_auth())
    assert res.status_code == 400, res.text
    assert res.json()["code"] == "invalid_request"
    assert "ephemeral" in res.json()["message"]
    assert not repo.contains_any()


# --- the harness ------------------------------------------------------------------------


async def _noop(_e: TaskEvent) -> None:
    return None


def test_parse_run_options_reads_ephemeral() -> None:
    assert parse_run_options({"ephemeral": True}).ephemeral is True
    assert parse_run_options({"ephemeral": "yes"}).ephemeral is False
    assert parse_run_options({}).ephemeral is False


async def test_ephemeral_run_offers_the_model_no_tools_and_no_suggestions() -> None:
    import asyncio

    model = _Model(_Call([text("It means…"), *usage(5, 2)]))
    web = tool("webSearch")
    harness = build_native_harness(
        Settings(),
        client=model,  # type: ignore[arg-type]
        build_tools=toolset(web),
        suggestions=True,
    )
    inp = run_input(
        options={"ephemeral": True, "skills": [{"id": "webSearch"}], "requireApprovalFor": ["x"]},
        tools=({"name": "clientTool", "description": "d", "parameters": {"type": "object"}},),
    )
    res = await harness.run(inp, RunEmitter(run_id=inp.run_id, sink=_noop), asyncio.Event())
    assert isinstance(res.outcome, Succeeded)
    # One model call (no suggestions call), offered nothing to call.
    (req,) = model.requests
    assert not req.get("tools")
    assert getattr(web, "calls") == []  # noqa: B009


def test_without_a_database_an_ephemeral_run_is_still_never_listed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # DB-less: a signed-in user's ordinary runs are in memory and listed;
    # the ephemeral one sits beside them, unlisted.
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    settings = Settings(SUPABASE_JWT_SECRET=SECRET, RUNS_STUB_HARNESS=True)
    services = build_run_services(settings, None)
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    thread = str(uuid.uuid4())
    with TestClient(app) as c:
        plain = _body(threadId=thread)
        del plain["forwardedProps"]
        assert c.post("/v1/runs", json=plain, headers=_auth()).status_code == 200
        assert c.post("/v1/runs", json=_body(threadId=thread), headers=_auth()).status_code == 200
        listed = c.get("/v1/runs", params={"threadId": thread}, headers=_auth())
    assert [r["id"] for r in listed.json()["runs"]] == [plain["runId"]]


def test_stub_ephemeral_run_never_interrupts(client: TestClient) -> None:
    body = _body({"conformance": {"outcome": "interrupt"}})
    assert client.post("/v1/runs", json=body, headers=_auth()).status_code == 200
    got = client.get(f"/v1/runs/{body['runId']}", headers=_auth())
    assert got.json()["status"] == "succeeded"
