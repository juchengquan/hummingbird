"""Q51: an interactive resume keeps the paused run's MCP allow-list.

Through `POST /v1/runs` with the native harness: the paused run stores the
list it ran with, and a resume may narrow it, never widen it, whatever
`forwardedProps` the client sends.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_py.main import create_app
from agent_py.runs import wiring
from agent_py.runs.native_harness import HARNESS_NAME

from .test_local_mcp import SECRET, _services
from .test_native_harness import MODEL, _Call, _Model, call, text

# Literal public IPs: the URL check stays off the network; nothing calls them.
SERVERS = [
    {
        "id": sid,
        "name": sid.upper(),
        "url": f"https://93.184.216.3{i}/mcp",
        "transport": "http",
        "capabilities": {"tools": [{"name": "echo"}]},
    }
    for i, sid in enumerate(("a", "b"))
]
ASK = {"prompt": "Which one?"}


class _Chat:
    """One anonymous thread on `/v1/runs`, every run ending on `askUser`."""

    def __init__(self, runs: int) -> None:
        self.model = _Model(
            *[_Call(tools=[call(f"c{i}", "askUser", **ASK)]) for i in range(runs - 1)],
            _Call([text("done")]),
        )
        self.services = _services(self.model)
        app = create_app(enable_poller=False)
        app.dependency_overrides[wiring.get_run_services] = lambda: self.services
        self.client = TestClient(app)
        self.thread = str(uuid.uuid4())
        self.messages: list[dict[str, Any]] = [{"id": "m1", "role": "user", "content": "go"}]
        self.previous: tuple[str, str] | None = None
        self.count = 0

    def send(self, allowed: list[str] | None) -> set[str]:
        """Start (or resume) a run; the MCP servers whose tools it offered."""
        props: dict[str, Any] = {"model": MODEL, "localMcpServers": SERVERS}
        if allowed is not None:
            props["allowedMcpServerIds"] = allowed
        body: dict[str, Any] = {
            "threadId": self.thread,
            "runId": str(uuid.uuid4()),
            "messages": list(self.messages),
            "forwardedProps": props,
        }
        headers: dict[str, str] = {}
        if self.previous is not None:
            props["previousRunId"], token = self.previous
            headers["X-Run-Token"] = token
            body["resume"] = [
                {
                    "interruptId": f"c{self.count - 1}",
                    "status": "resolved",
                    "payload": {"value": "this one"},
                }
            ]
        res = self.client.post("/v1/runs", json=body, headers=headers)
        assert res.status_code == 200, res.text
        self.previous = (body["runId"], res.headers["x-run-token"])
        self.messages.append(
            {
                "id": f"a{self.count}",
                "role": "assistant",
                "toolCalls": [
                    {
                        "id": f"c{self.count}",
                        "type": "function",
                        "function": {"name": "askUser", "arguments": '{"prompt":"Which one?"}'},
                    }
                ],
            }
        )
        offered = self.model.requests[self.count]["tools"]
        self.count += 1
        return {t["name"].split("__")[1] for t in offered if t["name"].startswith("mcp__")}


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)


@pytest.mark.parametrize(
    ("paused", "resumed", "expected"),
    [
        ([], None, set()),
        ([], ["a", "b"], set()),
        (["a"], None, {"a"}),
        (["a"], ["a", "b"], {"a"}),
        (["a"], ["b"], set()),
        (["a", "b"], ["b"], {"b"}),
        (None, ["a"], {"a"}),
        (None, None, {"a", "b"}),
    ],
)
def test_a_resume_can_narrow_but_never_widen(
    paused: list[str] | None, resumed: list[str] | None, expected: set[str]
) -> None:
    chat = _Chat(runs=2)
    assert chat.send(paused) == ({"a", "b"} if paused is None else set(paused))
    assert chat.send(resumed) == expected


def test_a_chain_of_resumes_keeps_the_narrowest_list() -> None:
    chat = _Chat(runs=3)
    assert chat.send(None) == {"a", "b"}
    assert chat.send(["a"]) == {"a"}
    assert chat.send(None) == {"a"}


@pytest.mark.parametrize("failure", ["missing", "load_error"])
def test_no_saved_state_means_no_mcp(monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    chat = _Chat(runs=2)
    chat.send(["a"])

    async def load(*_a: object, **_kw: object) -> None:
        if failure == "load_error":
            raise RuntimeError("database down")

    monkeypatch.setattr(chat.services.memory_repo, "load_checkpoint", load)
    assert chat.send(None) == set()


def test_a_background_runs_saved_list_holds_for_an_interactive_resume(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chat = _Chat(runs=2)
    chat.send(None)

    async def load(*_a: object, **_kw: object) -> dict[str, object]:
        return {"messages": [], "config": {"allowedMcpServerIds": ["a"]}}

    monkeypatch.setattr(chat.services.memory_repo, "load_checkpoint", load)
    assert chat.send(None) == {"a"}


def test_state_saved_before_the_fix_takes_the_resumes_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A run paused before the deploy recorded no list: there is nothing to
    hold the resume to."""
    chat = _Chat(runs=2)
    chat.send(None)

    async def load(*_a: object, **_kw: object) -> dict[str, object]:
        return {"harness": HARNESS_NAME, "version": 1}

    monkeypatch.setattr(chat.services.memory_repo, "load_checkpoint", load)
    assert chat.send(["b"]) == {"b"}
