"""Phase 4-1 tests — POST /v1/chat.

Hermetic — patches `resolve_anthropic_client` so the route never hits
Anthropic. We cover:

  - 401 without JWT.
  - 503 when `ANTHROPIC_API_KEY` is unset (resolver returns None).
  - 422 on schema violations (bad role, empty messages, bad model).
  - 200 + text/event-stream content-type on the happy path.
  - SSE body contains the right frame sequence (text deltas + done).
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import main as main_module
from agent_py.main import create_app

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


def _token() -> str:
    return jwt.encode(
        {"sub": "u", "role": "authenticated", "exp": int(time.time()) + 3600},
        SECRET,
        algorithm="HS256",
    )


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {_token()}"}


def _valid_body(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [{"role": "user", "content": "hi"}],
    }
    base.update(overrides)
    return base


def _text_event(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta",
        delta=SimpleNamespace(type="text_delta", text=text),
    )


class _FakeStream:
    def __init__(self, deltas: list[str]) -> None:
        self._deltas = deltas

    async def __aenter__(self) -> _FakeStream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
        return self._iter_events()

    async def _iter_events(self) -> AsyncIterator[SimpleNamespace]:
        for d in self._deltas:
            yield _text_event(d)

    @property
    def text_stream(self) -> AsyncIterator[str]:
        return self._iter_text()

    async def _iter_text(self) -> AsyncIterator[str]:
        for d in self._deltas:
            yield d

    async def get_final_message(self) -> dict[str, Any]:
        # Used by the tool-enabled paths; route smoke tests for the
        # text-only path don't reach this. Tool tests in
        # test_chat_route.py patch it directly when needed.
        return {"content": [{"type": "text", "text": "".join(self._deltas)}]}


class _FakeMessages:
    def __init__(self, deltas: list[str]) -> None:
        self._deltas = deltas

    def stream(self, **kwargs: Any) -> _FakeStream:
        return _FakeStream(self._deltas)


class _FakeClient:
    def __init__(self, deltas: list[str]) -> None:
        self.messages = _FakeMessages(deltas)


# --- failure paths ----------------------------------------------------


def test_chat_rejects_missing_token(client: TestClient) -> None:
    r = client.post("/v1/chat", json=_valid_body())
    assert r.status_code == 401


def test_chat_503_when_no_anthropic_key(client: TestClient) -> None:
    """Anthropic key unset → 503. Fast-fail signal to ops; do NOT
    fall through to the stub (the chat path is user-facing, the model
    being absent isn't recoverable on the server side)."""
    with patch.object(main_module, "resolve_anthropic_client", return_value=None):
        r = client.post("/v1/chat", json=_valid_body(), headers=_auth())
    assert r.status_code == 503
    assert "ANTHROPIC_API_KEY" in r.json()["detail"]


def test_chat_rejects_empty_messages(client: TestClient) -> None:
    r = client.post("/v1/chat", json={"model": "m", "messages": []}, headers=_auth())
    assert r.status_code == 422


def test_chat_rejects_invalid_role(client: TestClient) -> None:
    r = client.post(
        "/v1/chat",
        json={"model": "m", "messages": [{"role": "system", "content": "x"}]},
        headers=_auth(),
    )
    assert r.status_code == 422


def test_chat_rejects_empty_content(client: TestClient) -> None:
    r = client.post(
        "/v1/chat",
        json={"model": "m", "messages": [{"role": "user", "content": ""}]},
        headers=_auth(),
    )
    assert r.status_code == 422


def test_chat_rejects_missing_model(client: TestClient) -> None:
    r = client.post(
        "/v1/chat",
        json={"messages": [{"role": "user", "content": "x"}]},
        headers=_auth(),
    )
    assert r.status_code == 422


# --- happy path -------------------------------------------------------


def test_chat_streams_text_event_stream(client: TestClient) -> None:
    fake = _FakeClient(["Hello", " ", "world"])
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post("/v1/chat", json=_valid_body(), headers=_auth())

    assert r.status_code == 200
    ct = r.headers["content-type"]
    assert "text/event-stream" in ct
    assert r.headers.get("cache-control", "").startswith("no-cache")
    assert r.headers.get("x-accel-buffering") == "no"
    # AI SDK protocol advertised on every successful response after B.3.
    assert r.headers.get("x-vercel-ai-ui-message-stream") == "v1"

    # SSE body — AI SDK v5 UI message stream. Verify the textual
    # content arrives via text-delta frames between start/start-step
    # and finish-step/finish/[DONE].
    body = r.text
    events = [e for e in body.split("\n\n") if e.startswith("data: ")]
    import json

    parsed: list[object] = []
    for e in events:
        payload = e.removeprefix("data: ")
        parsed.append("[DONE]" if payload == "[DONE]" else json.loads(payload))
    types = [p["type"] if isinstance(p, dict) else p for p in parsed]
    assert types[0] == "start"
    assert types[1] == "start-step"
    assert "text-start" in types
    deltas = [p["delta"] for p in parsed if isinstance(p, dict) and p["type"] == "text-delta"]
    assert "".join(deltas) == "Hello world"
    assert types[-1] == "[DONE]"


def test_chat_forwards_system_prompt(client: TestClient) -> None:
    captured: dict[str, Any] = {}
    fake = _FakeClient([])

    real_stream = fake.messages.stream

    def capture(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return real_stream(**kwargs)

    fake.messages.stream = capture  # type: ignore[assignment]
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        client.post(
            "/v1/chat",
            json=_valid_body(system="You are a helpful test bot."),
            headers=_auth(),
        )

    assert captured.get("system") == "You are a helpful test bot."


def test_chat_max_tokens_default_applied(client: TestClient) -> None:
    captured: dict[str, Any] = {}
    fake = _FakeClient([])

    real_stream = fake.messages.stream

    def capture(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return real_stream(**kwargs)

    fake.messages.stream = capture  # type: ignore[assignment]
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        client.post("/v1/chat", json=_valid_body(), headers=_auth())
    # Default from chat.DEFAULT_MAX_TOKENS = 4096.
    assert captured.get("max_tokens") == 4096


# --- format=ai-sdk (Phase 3g) -----------------------------------------


def test_chat_ai_sdk_format_emits_ui_message_stream(client: TestClient) -> None:
    """`?format=ai-sdk` switches the wire to the AI SDK v5 UI
    message-stream protocol. Response carries the
    `x-vercel-ai-ui-message-stream: v1` header `useChat()` reads
    to confirm the protocol, and the body terminates with
    `data: [DONE]`."""
    import json

    fake = _FakeClient(["Hello", " world"])
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/chat?format=ai-sdk",
            json=_valid_body(),
            headers=_auth(),
        )
    assert r.status_code == 200
    assert "text/event-stream" in r.headers["content-type"]
    assert r.headers.get("x-vercel-ai-ui-message-stream") == "v1"

    events = [e for e in r.text.split("\n\n") if e.startswith("data: ")]
    payloads = [e.removeprefix("data: ") for e in events]
    types: list[str] = []
    for p in payloads:
        if p == "[DONE]":
            types.append("[DONE]")
        else:
            types.append(json.loads(p)["type"])
    assert types == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
        "[DONE]",
    ]


def test_chat_unknown_format_query_param_is_silently_ignored(
    client: TestClient,
) -> None:
    """B.3 retired the dual-format dispatch; the route always emits
    the AI SDK v5 UI message stream. The `?format=` query param is
    silently ignored — no 422 on a stale `?format=custom` from an
    old client."""
    fake = _FakeClient(["ok"])
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post("/v1/chat?format=bogus", json=_valid_body(), headers=_auth())
    assert r.status_code == 200
    # Still the AI SDK header.
    assert r.headers["x-vercel-ai-ui-message-stream"] == "v1"


# --- enable_tools dispatch (Phase 4-3) --------------------------------


def test_chat_enable_tools_dispatches_to_tool_stream(client: TestClient) -> None:
    """With `enable_tools: true`, the route uses the tool-enabled
    stream, which calls `messages.stream` with a `tools` kwarg
    populated from `default_tool_registry()`."""
    from unittest.mock import patch as _patch

    fake = _FakeClient(["only text"])

    real_stream = fake.messages.stream
    captured: dict[str, Any] = {}

    def capture(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return real_stream(**kwargs)

    fake.messages.stream = capture  # type: ignore[assignment]
    with (
        _patch.object(main_module, "resolve_anthropic_client", return_value=fake),
        # Patch `get_final_message` on the fake stream the route gets
        # so the tool-enabled loop terminates after one iteration.
        _patch.object(
            _FakeStream,
            "get_final_message",
            new=lambda self: _async_return({"content": [{"type": "text", "text": "only text"}]}),
            create=True,
        ),
    ):
        r = client.post(
            "/v1/chat",
            json=_valid_body(enable_tools=True),
            headers=_auth(),
        )
    assert r.status_code == 200
    # `tools` kwarg present + non-empty → tool dispatch fired.
    assert "tools" in captured
    assert len(captured["tools"]) > 0
    # webFetch is unconditional in the default registry — sanity-check
    # the descriptor surface.
    tool_names = {t["name"] for t in captured["tools"]}
    assert "webFetch" in tool_names

    # Body terminates with the AI SDK `[DONE]` marker.
    events = [e for e in r.text.split("\n\n") if e.startswith("data: ")]
    last = events[-1].removeprefix("data: ").strip()
    assert last == "[DONE]"


def _async_return(value: Any):  # type: ignore[no-untyped-def]
    async def _wrapped() -> Any:
        return value

    return _wrapped()


def test_chat_enable_tools_false_skips_tool_dispatch(client: TestClient) -> None:
    """Default `enable_tools=False` → no `tools` kwarg, route uses
    the Phase 4-1 text-only path."""
    fake = _FakeClient(["just text"])
    real_stream = fake.messages.stream
    captured: dict[str, Any] = {}

    def capture(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return real_stream(**kwargs)

    fake.messages.stream = capture  # type: ignore[assignment]
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        client.post("/v1/chat", json=_valid_body(), headers=_auth())
    assert "tools" not in captured


def test_chat_max_steps_clamped_at_schema_level(client: TestClient) -> None:
    """The wire schema clamps `max_steps` to [1, 20] — out of range
    → 422 before we even touch Anthropic."""
    r = client.post(
        "/v1/chat",
        json=_valid_body(enable_tools=True, max_steps=999),
        headers=_auth(),
    )
    assert r.status_code == 422


# --- workspace_id + per-skill config (Phase 4-3 follow-up) -----------


def test_chat_accepts_workspace_id_field(client: TestClient) -> None:
    """`workspace_id` is optional and just passes through. Without a
    DB pool wired in (tests don't open one), the route silently
    falls back to context-less registry — `searchFiles` + MCP omitted
    but the chat turn still runs."""
    fake = _FakeClient(["ok"])
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/chat",
            json=_valid_body(enable_tools=True, workspace_id="ws-1"),
            headers=_auth(),
        )
    assert r.status_code == 200


def test_chat_accepts_skills_array(client: TestClient) -> None:
    """`skills` array is optional, per-skill config is permissive
    (extra fields allowed). Sending it shouldn't break the request."""
    fake = _FakeClient(["ok"])
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/chat",
            json=_valid_body(
                enable_tools=True,
                skills=[
                    {"id": "imageGen", "imageGenConfig": {"maxCalls": 3}},
                    {"id": "webSearch", "webSearchConfig": {"maxCalls": 5}},
                ],
            ),
            headers=_auth(),
        )
    assert r.status_code == 200


def test_chat_workspace_id_max_length_enforced(client: TestClient) -> None:
    """`workspace_id` is capped at 64 chars to bound malformed input
    before it reaches the DB layer."""
    r = client.post(
        "/v1/chat",
        json=_valid_body(enable_tools=True, workspace_id="x" * 65),
        headers=_auth(),
    )
    assert r.status_code == 422


def test_chat_skills_array_capped(client: TestClient) -> None:
    """At most 20 skill entries per request — DoS guard on a list
    field that could in principle be unbounded."""
    r = client.post(
        "/v1/chat",
        json=_valid_body(
            enable_tools=True,
            skills=[{"id": f"skill-{i}"} for i in range(25)],
        ),
        headers=_auth(),
    )
    assert r.status_code == 422


def test_collect_skill_configs_reduces_list_to_dataclass() -> None:
    """`_collect_skill_configs` walks the request list and reduces
    to a `SkillConfigs` bundle keyed on the sub-object names."""
    from agent_py.main import _collect_skill_configs
    from agent_py.tools import SkillConfigs

    entries = main_module.ChatRequest(
        messages=[{"role": "user", "content": "x"}],
        model="claude",
        enable_tools=True,
        skills=[
            {"id": "imageGen", "imageGenConfig": {"maxCalls": 4}},
            {"id": "webSearch", "webSearchConfig": {"maxCalls": 7}},
            {"id": "webFetch"},  # No config block — silently skipped.
        ],
    ).skills

    result = _collect_skill_configs(entries)
    assert isinstance(result, SkillConfigs)
    assert result.image_gen == {"maxCalls": 4}
    assert result.web_search == {"maxCalls": 7}
    assert result.web_fetch is None


def test_collect_skill_configs_handles_none() -> None:
    from agent_py.main import _collect_skill_configs
    from agent_py.tools import SkillConfigs

    result = _collect_skill_configs(None)
    assert isinstance(result, SkillConfigs)
    assert result.image_gen is None
    assert result.web_search is None
    assert result.web_fetch is None
