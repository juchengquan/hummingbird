"""Background runs on `/v1/runs` without a database (wave 5b-A).

The router over an in-memory stand-in for the Postgres store (the
`InMemoryRunRepository` reference fake, plus the one Postgres-only call
the router makes, `enqueue_start`):

* start parity with the Next task route — `workspaceId`,
  `requireApprovalFor`, research mode (35 steps by default),
  `allowedMcpServerIds`, skills and reasoning effort land in the
  checkpoint config under the keys the executor reads;
* Q49 — a background start with attachments is `400 invalid_request`
  before anything exists;
* Q41 — a background resume starts from the paused run's checkpoint plus
  the answers; the paused run stays `interrupted`; an interactive run, a
  sub-agent run and a run answered the old way are refused (409).

The same against Postgres (0043's mutual exclusion included):
`test_background_runs_pg.py`.
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

from agent_py.main import create_app
from agent_py.resume_answers import RESUME_KEY
from agent_py.runs import wiring
from agent_py.runs.event_log import InMemoryRunEventLog
from agent_py.runs.model import Interrupted, PendingInterrupt, RunOwner
from agent_py.runs.repository import (
    CreateResult,
    InMemoryRunRepository,
    PreviousRunAlreadyAnswered,
    RunSpec,
)
from agent_py.runs.wiring import RunServices, build_run_services
from agent_py.settings import Settings

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER = "00000000-0000-4000-8000-000000000123"
CONV = "00000000-0000-4000-8000-0000000000c1"
OWNER = RunOwner.user(USER)


def _auth() -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": USER,
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
        super().__init__(conversations={USER: {CONV}})
        self.enqueued: list[str] = []
        self.answered_the_old_way: set[str] = set()

    async def enqueue_start(self, owner: RunOwner, run_id: str) -> None:
        self.enqueued.append(run_id)

    async def exists(self, run_id: str) -> bool:
        return run_id in self._rows

    async def create(self, owner: RunOwner, spec: RunSpec) -> CreateResult:
        # 0043's refusal in `create_run`.
        if spec.previous_run_id in self.answered_the_old_way:
            raise PreviousRunAlreadyAnswered()
        return await super().create(owner, spec)

    def set_parent(self, run_id: str, parent_id: str) -> None:
        row = self._rows[run_id]
        row.record = dataclasses.replace(row.record, parent_run_id=parent_id)


@pytest.fixture
def repo() -> FakePgRepo:
    return FakePgRepo()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, repo: FakePgRepo) -> Iterator[TestClient]:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    settings = Settings(
        SUPABASE_JWT_SECRET=SECRET,
        RUNS_STUB_HARNESS=True,
        RUNS_RATE_PER_MINUTE=1000,
        RUNS_ANONYMOUS_RATE_PER_MINUTE=1000,
    )
    services: RunServices = dataclasses.replace(
        build_run_services(settings, None),
        pg_repo=repo,  # type: ignore[arg-type]
        pg_log=InMemoryRunEventLog(),
    )
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    with TestClient(app) as c:
        yield c


def _body(fp: dict[str, Any], **kw: Any) -> dict[str, Any]:
    return {
        "threadId": kw.pop("threadId", CONV),
        "runId": kw.pop("runId", str(uuid.uuid4())),
        "messages": [{"id": "m1", "role": "user", "content": "Research the topic"}],
        "forwardedProps": {"mode": "background", **fp},
        **kw,
    }


# --- start parity ------------------------------------------------------------------


def test_start_carries_the_task_route_config(client: TestClient, repo: FakePgRepo) -> None:
    body = _body(
        {
            "research": True,
            "workspaceId": "ws-1",
            "requireApprovalFor": ["mcp__s1__send", "mcp__s1__send"],
            "allowedMcpServerIds": [],
            "skills": [{"id": "webSearch"}, {"id": "webFetch"}],
            "reasoningEffort": "medium",
            "systemPrompt": "Be brief.",
        }
    )
    r = client.post("/v1/runs", json=body, headers=_auth())
    assert r.status_code == 202, r.text
    cp = repo.checkpoint_of(body["runId"])
    assert cp is not None
    cfg = cp["config"]
    assert isinstance(cfg, dict)
    assert cfg["mode"] == "research"
    assert cfg["maxSteps"] == 35  # research default (app/api/tasks/route.ts)
    assert cfg["workspaceId"] == "ws-1"
    assert cfg["requireApprovalFor"] == ["mcp__s1__send"]
    assert cfg["allowedMcpServerIds"] == []
    assert cfg["skills"] == [{"id": "webSearch"}, {"id": "webFetch"}]
    assert cfg["reasoningEffort"] == "medium"
    assert cfg["workspaceSystemPrompt"] == "Be brief."
    assert repo.enqueued == [body["runId"]]
    run = client.get(f"/v1/runs/{body['runId']}", headers=_auth()).json()
    assert run["maxSteps"] == 35 and run["step"] == 0 and run["goal"] == "Research the topic"


def test_start_defaults(client: TestClient, repo: FakePgRepo) -> None:
    body = _body({})
    assert client.post("/v1/runs", json=body, headers=_auth()).status_code == 202
    cfg = repo.checkpoint_of(body["runId"])["config"]  # type: ignore[index]
    assert cfg["mode"] == "default" and cfg["maxSteps"] == 25
    # Absent allow-list → no key → no restriction.
    assert "allowedMcpServerIds" not in cfg
    assert "workspaceId" not in cfg and "requireApprovalFor" not in cfg
    research_capped = _body({"research": True, "maxSteps": 7})
    assert client.post("/v1/runs", json=research_capped, headers=_auth()).status_code == 202
    assert repo.checkpoint_of(research_capped["runId"])["config"]["maxSteps"] == 7  # type: ignore[index]


# --- Q49 -----------------------------------------------------------------------------

_BOOKMARK = {"kind": "bookmark", "url": "https://example.com", "title": "Example", "text": "Hi."}


def test_background_start_refuses_attachments(client: TestClient, repo: FakePgRepo) -> None:
    body = _body({"attachments": [_BOOKMARK]})
    r = client.post("/v1/runs", json=body, headers=_auth())
    assert r.status_code == 400 and r.json()["code"] == "invalid_request"
    assert repo.checkpoint_of(body["runId"]) is None and repo.enqueued == []
    # An interactive run takes them as before (here: the stub ignores them).
    inter = {**body, "forwardedProps": {"attachments": body["forwardedProps"]["attachments"]}}
    assert client.post("/v1/runs", json=inter, headers=_auth()).status_code == 200


def test_attachments_refused_even_without_a_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    services = build_run_services(
        Settings(SUPABASE_JWT_SECRET=SECRET, RUNS_STUB_HARNESS=True), None
    )
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    with TestClient(app) as c:
        body = _body({"attachments": [_BOOKMARK]})
        r = c.post("/v1/runs", json=body, headers=_auth())
    assert r.status_code == 400 and r.json()["code"] == "invalid_request"


# --- Q41 resume ----------------------------------------------------------------------

PAUSED_MESSAGES: list[dict[str, Any]] = [
    {"role": "user", "content": "Pick a colour and paint"},
    {
        "role": "assistant",
        "content": [
            {
                "type": "tool_use",
                "id": "call-ask",
                "name": "askUser",
                "input": {"prompt": "Which colour?"},
            }
        ],
    },
]
PAUSED_CONFIG: dict[str, Any] = {
    "model": "anthropic/claude-haiku-4.5",
    "maxSteps": 12,
    "mode": "research",
    "workspaceId": "ws-1",
    "allowedMcpServerIds": ["s1"],
}


async def _paused_background(repo: FakePgRepo, **kw: Any) -> str:
    run_id = str(uuid.uuid4())
    await repo.create(
        OWNER,
        RunSpec(
            run_id=run_id,
            thread_id=CONV,
            mode="background",
            goal="Paint",
            max_steps=12,
            checkpoint={"messages": PAUSED_MESSAGES, "config": PAUSED_CONFIG},
        ),
    )
    await repo.mark_running(run_id)
    await repo.settle(
        run_id,
        Interrupted(
            (
                PendingInterrupt(
                    id="call-ask",
                    request_kind="input",
                    tool="askUser",
                    tool_call_id="call-ask",
                    prompt="Which colour?",
                ),
            )
        ),
        checkpoint={
            "messages": PAUSED_MESSAGES,
            "config": PAUSED_CONFIG,
            "step": 3,
            "seq": 9,
            **kw,
        },
    )
    return run_id


def _resume_body(previous: str, **fp: Any) -> dict[str, Any]:
    return _body(
        {"previousRunId": previous, **fp},
        resume=[{"interruptId": "call-ask", "status": "resolved", "payload": {"value": "blue"}}],
    )


def test_resume_starts_from_the_paused_checkpoint(client: TestClient, repo: FakePgRepo) -> None:
    previous = client.portal.call(_paused_background, repo)  # type: ignore[union-attr]
    body = _resume_body(previous, research=False, workspaceId="ws-other")
    r = client.post("/v1/runs", json=body, headers=_auth())
    assert r.status_code == 202, r.text
    cp = repo.checkpoint_of(body["runId"])
    assert cp is not None
    # The paused run's messages and setup — not the resume request's.
    assert cp["messages"] == PAUSED_MESSAGES
    assert cp["config"] == {**PAUSED_CONFIG, "maxSteps": 12}
    assert cp[RESUME_KEY] == {
        "previousRunId": previous,
        "answers": [
            {"interruptId": "call-ask", "status": "resolved", "payload": {"value": "blue"}}
        ],
    }
    assert cp["step"] == 0 and cp["seq"] == 1
    assert repo.enqueued == [body["runId"]]
    new = client.get(f"/v1/runs/{body['runId']}", headers=_auth()).json()
    assert new["previousRunId"] == previous and new["goal"] == "Paint" and new["maxSteps"] == 12
    # The paused run stays interrupted.
    old = client.get(f"/v1/runs/{previous}", headers=_auth()).json()
    assert old["status"] == "interrupted" and old["openInterrupts"][0]["id"] == "call-ask"
    # One live resume.
    again = client.post("/v1/runs", json=_resume_body(previous), headers=_auth())
    assert again.status_code == 409 and again.json()["code"] == "run_already_resumed"


def test_resume_max_steps_override(client: TestClient, repo: FakePgRepo) -> None:
    previous = client.portal.call(_paused_background, repo)  # type: ignore[union-attr]
    body = _resume_body(previous, maxSteps=4)
    assert client.post("/v1/runs", json=body, headers=_auth()).status_code == 202
    assert repo.checkpoint_of(body["runId"])["config"]["maxSteps"] == 4  # type: ignore[index]


def test_resume_answered_the_old_way_is_409(client: TestClient, repo: FakePgRepo) -> None:
    previous = client.portal.call(_paused_background, repo)  # type: ignore[union-attr]
    repo.answered_the_old_way.add(previous)
    r = client.post("/v1/runs", json=_resume_body(previous), headers=_auth())
    assert r.status_code == 409 and r.json()["code"] == "run_already_answered"
    assert repo.enqueued == []


def test_resume_refuses_a_sub_agent_run(client: TestClient, repo: FakePgRepo) -> None:
    previous = client.portal.call(_paused_background, repo)  # type: ignore[union-attr]
    repo.set_parent(previous, str(uuid.uuid4()))
    r = client.post("/v1/runs", json=_resume_body(previous), headers=_auth())
    assert r.status_code == 409 and r.json()["code"] == "invalid_state"


def test_background_resume_of_an_interactive_run_is_409(client: TestClient) -> None:
    first = client.post(
        "/v1/runs",
        json={
            "threadId": CONV,
            "runId": str(uuid.uuid4()),
            "messages": [{"id": "m1", "role": "user", "content": "hi"}],
            "forwardedProps": {"conformance": {"outcome": "interrupt"}},
        },
        headers=_auth(),
    )
    assert first.status_code == 200
    # The stream ended interrupted.
    closing = next(line for line in first.text.splitlines() if '"RUN_FINISHED"' in line)
    run_id = json.loads(closing.removeprefix("data: "))["runId"]
    interrupts = client.get(f"/v1/runs/{run_id}", headers=_auth()).json()["openInterrupts"]
    body = _body(
        {"previousRunId": run_id},
        resume=[{"interruptId": i["id"], "status": "cancelled"} for i in interrupts],
    )
    r = client.post("/v1/runs", json=body, headers=_auth())
    assert r.status_code == 409 and r.json()["code"] == "invalid_state"


def test_resume_without_saved_state_is_409(client: TestClient, repo: FakePgRepo) -> None:
    previous = client.portal.call(_paused_background, repo)  # type: ignore[union-attr]
    repo._rows[previous].checkpoint = {"messages": [], "config": {}}
    r = client.post("/v1/runs", json=_resume_body(previous), headers=_auth())
    assert r.status_code == 409 and r.json()["code"] == "invalid_state"
