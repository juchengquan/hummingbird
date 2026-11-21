"""`/v1/runs` without a database: the runs router over the in-memory
store, the stub harness and the wave-3a fakes (`runs.wiring` with
`RUNS_STUB_HARNESS`). The same behaviour against Postgres is in
`test_runs_pg.py`; the language-neutral cases are the contract's
conformance suite (`packages/contract/conformance/runs.test.ts`)."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Iterator
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py.main import create_app
from agent_py.runs import wiring
from agent_py.runs.wiring import RunServices, build_run_services
from agent_py.settings import Settings

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER = "00000000-0000-4000-8000-000000000123"
OTHER = "00000000-0000-4000-8000-000000000456"


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


def _services(**overrides: Any) -> RunServices:
    values: dict[str, Any] = {
        "SUPABASE_JWT_SECRET": SECRET,
        "RUNS_STUB_HARNESS": True,
        "RUNS_RATE_PER_MINUTE": 1000,
        "RUNS_ANONYMOUS_RATE_PER_MINUTE": 1000,
        "RUNS_ANONYMOUS_MAX_CONCURRENT": 100,
        **overrides,
    }
    settings = Settings(**values)
    return build_run_services(settings, None)


@pytest.fixture
def services() -> RunServices:
    return _services()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, services: RunServices) -> Iterator[TestClient]:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    with TestClient(app) as c:
        yield c


def _body(**kw: Any) -> dict[str, Any]:
    fp: dict[str, Any] = {}
    for key in ("mode", "conformance", "previousRunId", "model", "goal", "maxSteps"):
        if key in kw:
            fp[key] = kw.pop(key)
    body: dict[str, Any] = {
        "threadId": kw.pop("threadId", str(uuid.uuid4())),
        "runId": kw.pop("runId", str(uuid.uuid4())),
        "messages": [{"id": "m1", "role": "user", "content": "hello"}],
        **kw,
    }
    if fp:
        body["forwardedProps"] = fp
    return body


def _sse(text: str) -> list[tuple[str | None, dict[str, Any]]]:
    out: list[tuple[str | None, dict[str, Any]]] = []
    for block in text.strip().split("\n\n"):
        event_id = None
        data = None
        for line in block.split("\n"):
            if line.startswith("id: "):
                event_id = line[4:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if data is not None:
            out.append((event_id, data))
    return out


def _cursor_key(event_id: str) -> tuple[int, float]:
    """`<seq>` sorts after every `<seq>.<k>` (it means "after the whole
    entry")."""
    seq, _, k = event_id.partition(".")
    return (int(seq), float(k) if k else float("inf"))


def _after(
    full: list[tuple[str | None, dict[str, Any]]], cut: str
) -> list[tuple[str | None, dict[str, Any]]]:
    """What a rejoin `after=cut` must send, given the full replay: the
    priming-free opening events, every event past `cut`, the closing
    events (opening / closing events carry no id)."""
    opening = [e for e in full[: next(i for i, e in enumerate(full) if e[0] is not None)]]
    body = [e for e in full if e[0] is not None and _cursor_key(e[0]) > _cursor_key(cut)]
    closing = full[max(i for i, e in enumerate(full) if e[0] is not None) + 1 :]
    return [*opening, *body, *closing]


def _start(client: TestClient, body: dict[str, Any], **kw: Any) -> Any:
    return client.post("/v1/runs", json=body, **kw)


# --- start -------------------------------------------------------------------------


def test_anonymous_interactive_start_streams_and_issues_a_token(client: TestClient) -> None:
    body = _body(conformance={"steps": 2})
    r = _start(client, body)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["location"] == f"/v1/runs/{body['runId']}"
    token = r.headers["x-run-token"]
    events = _sse(r.text)
    assert events[0] == (
        None,
        {"type": "RUN_STARTED", "threadId": body["threadId"], "runId": body["runId"]},
    )
    assert events[-1][0] is None and events[-1][1]["type"] == "RUN_FINISHED"
    ids = [e[0] for e in events[1:-1]]
    assert all(i is not None for i in ids)
    keys = [_cursor_key(str(i)) for i in ids]
    assert keys == sorted(keys) and len(set(keys)) == len(keys)
    # Entries that produce no AG-UI event (the closing `result`) send no id.
    seqs = sorted({k[0] for k in keys})

    run = client.get(f"/v1/runs/{body['runId']}", headers={"X-Run-Token": token})
    assert run.status_code == 200
    assert run.json()["status"] == "succeeded"
    assert run.json()["lastSeq"] >= seqs[-1]


def test_signed_in_start_has_no_run_token(client: TestClient) -> None:
    body = _body()
    r = _start(client, body, headers=_auth())
    assert r.status_code == 200 and "x-run-token" not in r.headers
    assert client.get(f"/v1/runs/{body['runId']}", headers=_auth()).json()["status"] == "succeeded"
    # another user: the same 404 as a missing run
    foreign = client.get(f"/v1/runs/{body['runId']}", headers=_auth(OTHER))
    missing = client.get(f"/v1/runs/{uuid.uuid4()}", headers=_auth())
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json() == {"code": "not_found", "message": "Run not found."}


def test_idempotent_retry_replays_and_conflicts_are_409(client: TestClient) -> None:
    body = _body(conformance={"steps": 3})
    first = _start(client, body)
    token = first.headers["x-run-token"]
    again = _start(client, body, headers={"X-Run-Token": token})
    assert again.status_code == 200 and again.text == first.text
    assert again.headers["x-run-token"] == token

    conflicts = [
        _start(client, body),  # without its token
        _start(client, body, headers={"X-Run-Token": "x" * 32}),  # another token
        _start(client, {**body, "threadId": str(uuid.uuid4())}, headers={"X-Run-Token": token}),
        _start(client, body, headers=_auth()),  # a signed-in user
    ]
    assert {r.status_code for r in conflicts} == {409}
    assert {r.text for r in conflicts} == {
        '{"code":"run_id_conflict","message":"This runId is already in use."}'
    }


def test_background_needs_sign_in_and_a_database(client: TestClient) -> None:
    anon = _start(client, _body(mode="background"))
    assert anon.status_code == 401 and anon.json()["code"] == "auth_required"
    signed = _start(client, _body(mode="background"), headers=_auth())
    assert signed.status_code == 503
    assert signed.json() == {"code": "unavailable", "message": "Supabase is not configured."}


def test_validation(client: TestClient) -> None:
    assert _start(client, {**_body(), "runId": "r1"}).status_code == 422
    assert _start(client, {**_body(), "mode": "background"}).status_code == 422  # closed schema
    no_prev = _start(client, _body(resume=[{"interruptId": "i", "status": "cancelled"}]))
    assert no_prev.status_code == 400 and no_prev.json()["code"] == "invalid_request"
    bad_model = _start(client, _body(model="openai/gpt-9"))
    assert bad_model.status_code == 400 and bad_model.json()["code"] == "unknown_model"


def test_resume_must_answer_exactly_the_open_interrupts(client: TestClient) -> None:
    thread = str(uuid.uuid4())
    first = _start(client, _body(threadId=thread, conformance={"outcome": "interrupt"}))
    token = first.headers["x-run-token"]
    prev = _sse(first.text)[-1][1]
    assert prev["outcome"]["type"] == "interrupt"
    interrupt_id = prev["outcome"]["interrupts"][0]["id"]
    prev_id = prev["runId"]
    headers = {"X-Run-Token": token}

    def resume(answers: list[dict[str, Any]], **kw: Any) -> Any:
        return _start(
            client,
            _body(threadId=kw.get("threadId", thread), previousRunId=prev_id, resume=answers),
            headers=kw.get("headers", headers),
        )

    wrong = resume([{"interruptId": "nope", "status": "cancelled"}])
    assert wrong.status_code == 409 and wrong.json()["code"] == "invalid_state"
    twice = resume([{"interruptId": interrupt_id, "status": "cancelled"}] * 2)
    assert twice.status_code == 409
    bad_payload = resume(
        [{"interruptId": interrupt_id, "status": "resolved", "payload": {"ok": 1}}]
    )
    assert bad_payload.status_code == 400
    other_thread = resume(
        [{"interruptId": interrupt_id, "status": "cancelled"}], threadId=str(uuid.uuid4())
    )
    assert other_thread.status_code == 409
    no_token = resume([{"interruptId": interrupt_id, "status": "cancelled"}], headers={})
    assert no_token.status_code == 409  # not provably the caller's run

    ok = resume(
        [{"interruptId": interrupt_id, "status": "resolved", "payload": {"approved": True}}]
    )
    assert ok.status_code == 200
    assert ok.headers["x-run-token"] == token  # the answering run stays under the thread's token
    new_id = _sse(ok.text)[0][1]["runId"]
    run = client.get(f"/v1/runs/{new_id}", headers=headers).json()
    assert run["status"] == "succeeded" and run["previousRunId"] == prev_id
    assert "Resumed" in run["result"]["text"]


def test_require_auth_for_ai(monkeypatch: pytest.MonkeyPatch, services: RunServices) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("REQUIRE_AUTH_FOR_AI", "true")
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    with TestClient(app) as c:
        anon = c.post("/v1/runs", json=_body())
        assert anon.status_code == 401
        assert anon.json() == {
            "code": "auth_required",
            "message": "Sign in to use AI features on this server.",
        }
        assert c.post("/v1/runs", json=_body(), headers=_auth()).status_code == 200


def test_require_auth_for_ai_typo_fails_closed(
    monkeypatch: pytest.MonkeyPatch, services: RunServices
) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("REQUIRE_AUTH_FOR_AI", "yes")
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.post("/v1/runs", json=_body())
        assert r.status_code == 500 and r.json()["code"] == "unknown"


def test_anonymous_limits_answer_429(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    limited = _services(RUNS_ANONYMOUS_RATE_PER_MINUTE=2)
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: limited
    with TestClient(app) as c:
        assert c.post("/v1/runs", json=_body()).status_code == 200
        assert c.post("/v1/runs", json=_body()).status_code == 200
        third = c.post("/v1/runs", json=_body())
        assert third.status_code == 429
        assert third.json()["code"] == "rate_limit" and int(third.headers["retry-after"]) >= 1
        assert c.post("/v1/runs", json=_body(), headers=_auth()).status_code == 200


def test_memory_store_full_is_503(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    small = _services(RUNS_MEMORY_MAX_RUNS=1)
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: small
    with TestClient(app) as c:
        assert c.post("/v1/runs", json=_body()).status_code == 200
        full = c.post("/v1/runs", json=_body())
        assert full.status_code == 503 and full.json()["code"] == "unavailable"


# --- one run: credentials, rejoin, cancel ---------------------------------------------


def test_run_credentials(client: TestClient) -> None:
    body = _body()
    token = _start(client, body).headers["x-run-token"]
    url = f"/v1/runs/{body['runId']}"
    assert client.get(url).status_code == 401
    assert client.get(url, headers={"X-Run-Token": "short"}).status_code == 401
    assert client.get(url, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get(url, headers={"X-Run-Token": "y" * 32}).status_code == 404
    # A present Authorization header wins over the token.
    assert client.get(url, headers={"X-Run-Token": token, **_auth()}).status_code == 404
    assert client.get("/v1/runs/not-a-uuid", headers={"X-Run-Token": token}).status_code == 404
    assert client.get("/v1/runs", headers={"X-Run-Token": token}).status_code == 401


def test_rejoin_from_a_cursor(client: TestClient) -> None:
    body = _body(conformance={"steps": 3})
    first = _start(client, body)
    headers = {"X-Run-Token": first.headers["x-run-token"]}
    full = _sse(first.text)
    url = f"/v1/runs/{body['runId']}/events"
    assert _sse(client.get(url, headers=headers).text) == full
    ids = [e[0] for e in full if e[0] is not None]
    last_seq = max(_cursor_key(i)[0] for i in ids)
    for cut in ("1", ids[3], ids[-2], str(last_seq), "2"):
        tail = _sse(client.get(url, params={"after": cut}, headers=headers).text)
        assert tail == _after(full, cut), cut
        via_header = client.get(url, headers={**headers, "Last-Event-ID": cut})
        assert _sse(via_header.text) == tail
    for bad in ("x", "1.2.3", "007", str(last_seq + 5)):
        r = client.get(url, params={"after": bad}, headers=headers)
        assert r.status_code == 400 and r.json()["code"] == "invalid_request", bad


def test_cancel_is_idempotent_and_returns_the_run(client: TestClient) -> None:
    thread = str(uuid.uuid4())
    body = _body(threadId=thread, conformance={"outcome": "interrupt"})
    _start(client, body, headers=_auth())
    url = f"/v1/runs/{body['runId']}"
    assert client.get(url, headers=_auth()).json()["status"] == "interrupted"
    first = client.post(f"{url}/cancel", headers=_auth())
    second = client.post(f"{url}/cancel", headers=_auth())
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["status"] == "cancelled" and first.json()["openInterrupts"] == []
    # a finished run is returned unchanged
    done = _body()
    _start(client, done, headers=_auth())
    before = client.get(f"/v1/runs/{done['runId']}", headers=_auth()).json()
    assert client.post(f"/v1/runs/{done['runId']}/cancel", headers=_auth()).json() == before
    assert client.post(f"/v1/runs/{uuid.uuid4()}/cancel", headers=_auth()).status_code == 404


# --- list ----------------------------------------------------------------------------------


def test_list_runs_filters_and_pages(client: TestClient) -> None:
    thread = str(uuid.uuid4())
    ids = []
    for outcome in ("succeed", "fail", "succeed"):
        body = _body(threadId=thread, conformance={"outcome": outcome})
        assert _start(client, body, headers=_auth()).status_code == 200
        ids.append(body["runId"])
        time.sleep(0.002)  # distinct createdAt
    newest = ids[::-1]

    def listing(**params: Any) -> Any:
        return client.get("/v1/runs", params={"threadId": thread, **params}, headers=_auth())

    page = listing().json()
    assert [r["id"] for r in page["runs"]] == newest and page["nextPageToken"] is None
    walked, token = [], None
    while True:
        p = listing(pageSize=1, **({"pageToken": token} if token else {})).json()
        walked += [r["id"] for r in p["runs"]]
        token = p["nextPageToken"]
        if not token:
            break
    assert walked == newest
    assert [r["id"] for r in listing(status="failed").json()["runs"]] == [ids[1]]
    both = client.get(
        "/v1/runs",
        params=[("threadId", thread), ("status", "failed"), ("status", "succeeded")],
        headers=_auth(),
    )
    assert len(both.json()["runs"]) == 3
    assert listing(mode="background").json()["runs"] == []
    assert listing(pageSize=0).status_code == 422
    assert listing(pageSize=101).status_code == 422
    assert listing(pageToken="garbage").status_code == 400
    first = listing(pageSize=1).json()["nextPageToken"]
    assert listing(mode="interactive", pageToken=first).status_code == 400
    assert client.get("/v1/runs", params={"threadId": thread}, headers=_auth(OTHER)).json() == {
        "runs": [],
        "nextPageToken": None,
    }
    assert client.get("/v1/runs").status_code == 401


def test_maintenance_drops_expired_memory_runs(services: RunServices, client: TestClient) -> None:
    body = _body()
    token = _start(client, body).headers["x-run-token"]
    url = f"/v1/runs/{body['runId']}"
    assert client.get(url, headers={"X-Run-Token": token}).status_code == 200
    services.memory_repo._ttl = services.memory_repo._ttl * 0  # expire immediately
    client.portal.call(services.maintain)  # type: ignore[union-attr]
    assert client.get(url, headers={"X-Run-Token": token}).status_code == 404
