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


class _FakeStream:
    def __init__(self, deltas: list[str]) -> None:
        self._deltas = deltas

    async def __aenter__(self) -> _FakeStream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    @property
    def text_stream(self) -> AsyncIterator[str]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[str]:
        for d in self._deltas:
            yield d


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

    # SSE body — text frames + done. We parse loosely (split on \n\n).
    body = r.text
    events = [e for e in body.split("\n\n") if e.startswith("data: ")]
    assert len(events) == 4  # 3 text + 1 done
    import json

    parsed = [json.loads(e.removeprefix("data: ")) for e in events]
    assert parsed[0] == {"type": "text", "value": "Hello"}
    assert parsed[1] == {"type": "text", "value": " "}
    assert parsed[2] == {"type": "text", "value": "world"}
    assert parsed[3] == {"type": "done"}


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
