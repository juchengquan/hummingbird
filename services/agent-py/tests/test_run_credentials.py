"""Local MCP credentials never persist (Q42, Q45; `runs/credentials.py`).

A run started with `state["hummingbird.localMcp"]` hands the credentials
to the harness (`RunInput.local_mcp_credentials`) and nowhere else: not
the stored run (row, checkpoint, outcome), not its event log, not a log
line, not a response (stream, run resource, error), not a repr. Covered
for an anonymous run that interrupts and is resumed (the resume re-sends
the credentials), a signed-in run in the signed-in store, a background
start, and a 422. The Postgres store gets the same check in
`test_runs_pg.py` (`test_local_mcp_credentials_never_reach_postgres`).
"""

from __future__ import annotations

import dataclasses
import logging
import time
import uuid
from collections.abc import Iterator
from typing import Any

import jwt
import pytest
import structlog
from fastapi.testclient import TestClient

from agent_py.contract import models
from agent_py.emitter import RunEmitter
from agent_py.main import create_app
from agent_py.runs import wiring
from agent_py.runs.credentials import LOCAL_MCP_STATE_KEY, LocalMcpCredential, split_state
from agent_py.runs.event_log_memory import MemoryRunEventLog
from agent_py.runs.harness import CancelSignal, HarnessAdapter, HarnessResult, RunInput
from agent_py.runs.model import RunOwner
from agent_py.runs.native_harness import build_native_harness
from agent_py.runs.repository import InMemoryRunRepository
from agent_py.runs.run_input import build_run_input
from agent_py.runs.wiring import RunServices, build_run_services
from agent_py.settings import Settings

from .test_native_harness import MODEL, _Call, _Model, call, text, tool, toolset

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER = "00000000-0000-4000-8000-000000000123"
CRED_SECRET = "sk-live-local-mcp-NEVER-STORE-7f3a"
TYPE_SECRET = "bearer-type-marker-91c2"


def _auth() -> dict[str, str]:
    token = jwt.encode(
        {"sub": USER, "role": "authenticated", "aud": "authenticated", "exp": time.time() + 600},
        SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _state() -> dict[str, Any]:
    return {
        LOCAL_MCP_STATE_KEY: {
            "srv-1": {"type": TYPE_SECRET, "headers": {"Authorization": f"Bearer {CRED_SECRET}"}}
        },
        "other": {"kept": True},
    }


def _body(**kw: Any) -> dict[str, Any]:
    fp = {
        "model": MODEL,
        "requireApprovalFor": ["echo"],
        "localMcpServers": [{"id": "srv-1", "name": "Local", "url": "http://localhost:9/mcp"}],
        **kw.pop("fp", {}),
    }
    return {
        "threadId": kw.pop("threadId", str(uuid.uuid4())),
        "runId": kw.pop("runId", str(uuid.uuid4())),
        "messages": [{"id": "m1", "role": "user", "content": "hello"}],
        "state": _state(),
        "forwardedProps": fp,
        **kw,
    }


# --- a deep walk over everything an object holds ---------------------------------------


def _strings(obj: object, seen: set[int] | None = None, depth: int = 0) -> Iterator[str]:
    """Every string reachable from `obj` — dataclass fields whatever their
    `repr`, mappings (keys and values), sequences, plain objects' `vars()`."""
    seen = set() if seen is None else seen
    if depth > 40 or id(obj) in seen:
        return
    seen.add(id(obj))
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, bytes):
        yield obj.decode("utf-8", "replace")
    elif isinstance(obj, (int, float, bool)) or obj is None:
        return
    elif dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        for f in dataclasses.fields(obj):
            yield from _strings(getattr(obj, f.name, None), seen, depth + 1)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from _strings(k, seen, depth + 1)
            yield from _strings(v, seen, depth + 1)
    elif isinstance(obj, (list, tuple, set, frozenset)):
        for v in obj:
            yield from _strings(v, seen, depth + 1)
    elif hasattr(obj, "__dict__") and not callable(obj):
        yield from _strings(vars(obj), seen, depth + 1)
    else:
        yield repr(obj)


def _leaks(obj: object) -> list[str]:
    return [s for s in _strings(obj) if CRED_SECRET in s or TYPE_SECRET in s]


# --- harness wrapper -------------------------------------------------------------------


class _Recording:
    """Records each `RunInput`, then runs the native harness."""

    name = "loop-v1"

    def __init__(self, inner: HarnessAdapter) -> None:
        self.inner = inner
        self.inputs: list[RunInput] = []

    async def run(
        self, run_input: RunInput, emitter: RunEmitter, cancel: CancelSignal
    ) -> HarnessResult:
        self.inputs.append(run_input)
        return await self.inner.run(run_input, emitter, cancel)


class _SignedInStore(InMemoryRunRepository):
    """The in-memory repository standing in for Postgres (signed-in runs)."""

    async def exists(self, run_id: str) -> bool:
        return run_id in self._rows

    async def enqueue_start(self, owner: RunOwner, run_id: str) -> None:
        return None


def _services(model: _Model, *, signed_in_store: _SignedInStore | None = None) -> RunServices:
    settings = Settings(
        SUPABASE_JWT_SECRET=SECRET,
        RUNS_RATE_PER_MINUTE=1000,
        RUNS_ANONYMOUS_RATE_PER_MINUTE=1000,
        RUNS_ANONYMOUS_MAX_CONCURRENT=100,
    )
    harness = _Recording(
        build_native_harness(
            settings,
            client=model,  # type: ignore[arg-type]
            build_tools=toolset(tool("echo")),
            suggestions=False,
        )
    )
    services = build_run_services(settings, None, harness=harness)
    if signed_in_store is not None:
        services = dataclasses.replace(
            services,
            pg_repo=signed_in_store,  # type: ignore[arg-type]
            pg_log=MemoryRunEventLog(),
        )
    return services


@pytest.fixture
def make_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    clients: list[TestClient] = []

    def make(services: RunServices) -> TestClient:
        app = create_app(enable_poller=False)
        app.dependency_overrides[wiring.get_run_services] = lambda: services
        c = TestClient(app)
        c.__enter__()
        clients.append(c)
        return c

    yield make
    for c in clients:
        c.__exit__(None, None, None)


# --- units -----------------------------------------------------------------------------


def test_split_state_takes_the_credentials_out() -> None:
    state = _state()
    rest, creds = split_state(state)
    assert rest == {"other": {"kept": True}}
    assert creds["srv-1"].headers == {"Authorization": f"Bearer {CRED_SECRET}"}
    assert LOCAL_MCP_STATE_KEY in state  # the caller's object is left alone
    assert split_state({LOCAL_MCP_STATE_KEY: {"s": "junk"}}) == (None, {})
    assert split_state(None) == (None, {})
    cred = LocalMcpCredential(type="bearer", headers={"Authorization": CRED_SECRET})
    assert CRED_SECRET not in repr(cred) and CRED_SECRET not in str(cred)


def test_build_run_input_holds_them_only_in_the_hidden_field() -> None:
    body = models.StartRunRequest.model_validate(_body())
    ri = build_run_input(
        body, mode="interactive", user_id=None, previous_run_id=None, client_key="1.2.3.4"
    )
    assert ri.client_key == "1.2.3.4"
    assert ri.local_mcp_credentials["srv-1"].headers["Authorization"] == f"Bearer {CRED_SECRET}"
    assert ri.state == {"other": {"kept": True}}
    assert CRED_SECRET not in repr(ri) and TYPE_SECRET not in repr(ri)
    assert CRED_SECRET not in str(ri.options) and CRED_SECRET not in repr(ri.state)


# --- through the API -------------------------------------------------------------------


def test_anonymous_interrupted_and_resumed_run_stores_and_logs_no_credentials(
    make_client: Any, caplog: pytest.LogCaptureFixture
) -> None:
    model = _Model(_Call(tools=[call("c1", "echo", x=1)]), _Call([text("done")]))
    services = _services(model)
    client = make_client(services)
    caplog.set_level(logging.DEBUG)
    with structlog.testing.capture_logs() as logs:
        first = _body()
        r1 = client.post("/v1/runs", json=first)
        assert r1.status_code == 200
        token = r1.headers["x-run-token"]
        run1 = client.get(f"/v1/runs/{first['runId']}", headers={"X-Run-Token": token})
        assert run1.json()["status"] == "interrupted"

        # The resume is a new run: it re-sends the credentials.
        second = _body(
            threadId=first["threadId"],
            fp={"previousRunId": first["runId"]},
            resume=[{"interruptId": "c1", "status": "resolved", "payload": {"approved": True}}],
        )
        r2 = client.post("/v1/runs", json=second, headers={"X-Run-Token": token})
        assert r2.status_code == 200
        run2 = client.get(f"/v1/runs/{second['runId']}", headers={"X-Run-Token": token})
        assert run2.json()["status"] == "succeeded"

    harness = services.harness
    assert isinstance(harness, _Recording)
    assert [list(ri.local_mcp_credentials) for ri in harness.inputs] == [["srv-1"], ["srv-1"]]
    # The checkpoint the resume continued from was stored — and is clean.
    assert services.memory_repo.checkpoint_of(first["runId"]) is not None
    assert _leaks(services.memory_repo) == []
    assert _leaks(services.memory_log) == []
    for r in (r1, r2, run1, run2):
        assert CRED_SECRET not in r.text and TYPE_SECRET not in r.text
    assert _leaks(logs) == []
    assert all(CRED_SECRET not in rec.getMessage() for rec in caplog.records)
    assert CRED_SECRET not in caplog.text
    # Nothing the model saw either (the credentials are for the MCP call).
    assert _leaks(model.requests) == []


def test_signed_in_run_stores_no_credentials(make_client: Any) -> None:
    store = _SignedInStore()
    model = _Model(_Call([text("hi")]))
    services = _services(model, signed_in_store=store)
    client = make_client(services)
    with structlog.testing.capture_logs() as logs:
        body = _body()
        r = client.post("/v1/runs", json=body, headers=_auth())
        assert r.status_code == 200
        run = client.get(f"/v1/runs/{body['runId']}", headers=_auth())
    assert run.json()["status"] == "succeeded"
    assert body["runId"] in store._rows
    assert _leaks(store) == []
    assert _leaks(services.pg_log) == []
    assert CRED_SECRET not in r.text and CRED_SECRET not in run.text
    assert _leaks(logs) == []


def test_background_start_with_credentials_is_refused_and_stores_nothing(
    make_client: Any,
) -> None:
    """Q42: a background start carrying local MCP (servers or only the
    credentials in `state`) is `400 invalid_request` before any row."""
    thread = str(uuid.uuid4())
    store = _SignedInStore(conversations={USER: {thread}})
    services = _services(_Model(), signed_in_store=store)
    client = make_client(services)
    body = _body(threadId=thread, fp={"mode": "background", "goal": "g"})
    with structlog.testing.capture_logs() as logs:
        r = client.post("/v1/runs", json=body, headers=_auth())
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "invalid_request"
    assert CRED_SECRET not in r.text and TYPE_SECRET not in r.text
    assert body["runId"] not in store._rows
    assert _leaks(store) == []
    assert _leaks(services.pg_log) == []
    assert _leaks(logs) == []


def test_a_rejected_body_does_not_echo_the_credentials(make_client: Any) -> None:
    client = make_client(_services(_Model()))
    body = _body()
    body["runId"] = "not-a-uuid"
    r = client.post("/v1/runs", json=body)
    assert r.status_code == 422
    assert CRED_SECRET not in r.text and TYPE_SECRET not in r.text
