"""The wave-6 seam (contract 0.5.0) without a database: the `Run` task
fields with their defaults, the in-place answer's job payload, the
`listRuns` task filters and the two planned operations, which answer
`501 not_implemented` until wave 6-A implements them."""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py.contract import models
from agent_py.main import create_app
from agent_py.runs import wiring
from agent_py.runs.in_place import respond_job_payload
from agent_py.runs.model import (
    Interrupted,
    PendingInterrupt,
    RunOwner,
    RunRecord,
    run_to_contract,
)
from agent_py.runs.repository import InMemoryRunRepository, RunFilter, RunSpec
from agent_py.runs.wiring import build_run_services
from agent_py.settings import Settings

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER = "00000000-0000-4000-8000-000000000123"
THREAD = "00000000-0000-4000-8000-0000000000ee"


def _auth() -> dict[str, str]:
    claims = {
        "sub": USER,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 600,
    }
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    services = build_run_services(
        Settings(SUPABASE_JWT_SECRET=SECRET, RUNS_STUB_HARNESS=True), None
    )
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    with TestClient(app) as c:
        yield c


def _record(**kw: Any) -> RunRecord:
    now = datetime(2026, 11, 23, tzinfo=UTC)
    values: dict[str, Any] = {
        "id": "8a6e0804-2bd0-4672-b79d-d97027f9071a",
        "owner": RunOwner.user(USER),
        "thread_id": THREAD,
        "mode": "background",
        "internal_status": "running",
        "created_at": now,
        "updated_at": now,
        **kw,
    }
    return RunRecord(**values)


def test_a_run_has_the_task_fields_and_validates() -> None:
    run = run_to_contract(_record(), last_seq=3)
    assert run["rootRunId"] == run["id"], "a run with no recorded root is its own"
    assert run["currentRunId"] is None
    assert (run["research"], run["delivered"], run["childrenAsking"], run["answerPending"]) == (
        False,
        False,
        0,
        False,
    )
    models.Run.model_validate(run)

    root = "11111111-1111-4111-8111-111111111111"
    later = "22222222-2222-4222-8222-222222222222"
    paused = run_to_contract(
        _record(
            internal_status="paused",
            open_interrupts=({"id": "q", "reason": "input"},),
            root_run_id=root,
            current_run_id=later,
            research=True,
            delivered=True,
            children_asking=2,
            answer_pending=True,
        ),
        last_seq=3,
    )
    assert paused["rootRunId"] == root and paused["currentRunId"] == later
    assert paused["research"] and paused["delivered"] and paused["answerPending"]
    assert paused["childrenAsking"] == 2
    models.Run.model_validate(paused)
    # `answerPending` only means something while interrupted; `delivered`
    # only for a background run.
    running = run_to_contract(_record(answer_pending=True), last_seq=0)
    assert running["answerPending"] is False
    chat = run_to_contract(_record(mode="interactive", delivered=True), last_seq=0)
    assert chat["delivered"] is False


@pytest.mark.parametrize(
    ("entry", "payload"),
    [
        (
            {"interruptId": "q", "status": "resolved", "payload": {"approved": True, "args": {}}},
            {"requestId": "q", "approved": True, "args": {}},
        ),
        (
            {"interruptId": "q", "status": "resolved", "payload": {"selection": ["a"]}},
            {"requestId": "q", "selection": ["a"]},
        ),
        (
            {"interruptId": "q", "status": "resolved", "payload": {"value": "red", "x": 1}},
            {"requestId": "q", "value": "red"},
        ),
        (
            {"interruptId": "q", "status": "resolved", "payload": {"uiAnswer": {"k": 1}}},
            {"requestId": "q", "uiAnswer": {"k": 1}},
        ),
        ({"interruptId": "q", "status": "cancelled"}, {"requestId": "q", "cancelled": True}),
    ],
)
def test_an_in_place_answer_becomes_a_respond_job_payload(
    entry: dict[str, Any], payload: dict[str, Any]
) -> None:
    assert respond_job_payload(entry) == payload


@pytest.mark.parametrize("entry", [{"status": "resolved"}, {"interruptId": "q", "status": "maybe"}])
def test_a_malformed_entry_is_refused(entry: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        respond_job_payload(entry)


def test_old_page_tokens_keep_their_fingerprint() -> None:
    # The 0.4 filter set hashes as before (no task filter appended).
    filt = RunFilter(thread_id=THREAD, mode="background")
    assert filt.fingerprint() == RunFilter(thread_id=THREAD, mode="background").fingerprint()
    assert (
        filt.fingerprint()
        != RunFilter(thread_id=THREAD, mode="background", current=True).fingerprint()
    )
    assert RunFilter(top_level=True).fingerprint() != RunFilter(top_level=False).fingerprint()


async def test_the_memory_store_roots_a_resume_at_its_previous_run() -> None:
    repo = InMemoryRunRepository(conversations={USER: {THREAD}})
    owner = RunOwner.user(USER)
    first = await repo.create(
        owner,
        RunSpec(
            run_id=str(uuid.uuid4()),
            thread_id=THREAD,
            mode="background",
            goal="g",
            max_steps=3,
            checkpoint={"messages": [], "config": {"mode": "research"}},
        ),
    )
    assert first.run.root_run_id == first.run.id and first.run.research
    await repo.settle(first.run.id, _interrupted())
    resume = await repo.create(
        owner,
        RunSpec(
            run_id=str(uuid.uuid4()),
            thread_id=THREAD,
            mode="background",
            goal="g",
            previous_run_id=first.run.id,
            max_steps=3,
            checkpoint={"messages": [], "config": {}},
        ),
    )
    assert resume.run.root_run_id == first.run.id
    assert resume.run.research, "a resume inherits research"


def _interrupted() -> Interrupted:
    return Interrupted((PendingInterrupt(id="q", request_kind="input"),))


def test_the_planned_operations_answer_501(client: TestClient) -> None:
    run = "00000000-0000-4000-8000-0000000000cc"
    body = {"resume": [{"interruptId": "q", "status": "cancelled"}]}
    answered = client.post(f"/v1/runs/{run}/answers", json=body, headers=_auth())
    assert answered.status_code == 501 and answered.json()["code"] == "not_implemented"
    delivered = client.post(f"/v1/runs/{run}/delivered", headers=_auth())
    assert delivered.status_code == 501 and delivered.json()["code"] == "not_implemented"
    # Signed-in callers only.
    assert client.post(f"/v1/runs/{run}/answers", json=body).status_code == 401
    assert client.post(f"/v1/runs/{run}/delivered").status_code == 401
    # The body is the contract's.
    assert (
        client.post(f"/v1/runs/{run}/answers", json={"resume": []}, headers=_auth()).status_code
        == 422
    )


@pytest.mark.parametrize(
    "query",
    ["topLevel=true", "current=false", f"rootRunId={THREAD}", "delivered=false"],
)
def test_list_task_filters_answer_501_until_implemented(client: TestClient, query: str) -> None:
    listed = client.get(f"/v1/runs?mode=background&{query}", headers=_auth())
    assert listed.status_code == 501, listed.text
    assert client.get("/v1/runs?mode=background", headers=_auth()).status_code == 200
