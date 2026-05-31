"""Phase 4-4b tests — `summarise` helper + `/v1/summarize` route.

The Anthropic SDK is faked at the `messages.stream` boundary so the
multi-mode dispatch + JSON parsing + error mapping can be exercised
without hitting the network.
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
from agent_py.chat import ChatMessage
from agent_py.main import create_app
from agent_py.summarise import (
    DEFAULT_SUMMARY_MODEL,
    SummariseError,
    SummariseOk,
    is_anthropic_model_id,
    resolve_model,
    strip_json_fences,
    summarise_compress,
    summarise_conversation,
    summarise_file,
    summarise_project_breakdown,
)

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


# --- Anthropic fake -------------------------------------------------


class _FakeStream:
    def __init__(self, text: str, raises: Exception | None = None) -> None:
        self._text = text
        self._raises = raises

    async def __aenter__(self) -> _FakeStream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    @property
    def text_stream(self) -> AsyncIterator[str]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[str]:
        if self._raises is not None:
            raise self._raises
        if self._text:
            yield self._text

    async def get_final_message(self) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": self._text}]}


class _FakeMessages:
    def __init__(self, text: str, raises: Exception | None = None) -> None:
        self._text = text
        self._raises = raises
        self.calls: list[dict[str, Any]] = []

    def stream(self, **kwargs: Any) -> _FakeStream:
        self.calls.append(kwargs)
        return _FakeStream(self._text, self._raises)


class _FakeClient:
    def __init__(self, text: str = "", raises: Exception | None = None) -> None:
        self.messages = _FakeMessages(text, raises)


# --- resolve_model / is_anthropic_model_id --------------------------


def test_is_anthropic_model_id_matches_claude_ids() -> None:
    assert is_anthropic_model_id("claude-3-5-haiku-20241022")
    assert is_anthropic_model_id("Claude-3-5-Sonnet")
    assert not is_anthropic_model_id("google/gemini-2.5-flash")
    assert not is_anthropic_model_id("openai/gpt-4o-mini")
    assert not is_anthropic_model_id("")


def test_resolve_model_passes_anthropic_through() -> None:
    assert resolve_model("claude-3-7-sonnet") == "claude-3-7-sonnet"


def test_resolve_model_falls_back_to_default_for_non_anthropic() -> None:
    # The TS default `google/gemini-2.5-flash` is the canary — it
    # comes in unchanged from the apiClient body.
    assert resolve_model("google/gemini-2.5-flash") == DEFAULT_SUMMARY_MODEL
    assert resolve_model(None) == DEFAULT_SUMMARY_MODEL


# --- strip_json_fences ----------------------------------------------


def test_strip_json_fences_unwraps_json_block() -> None:
    assert strip_json_fences('```json\n{"a":1}\n```') == '{"a":1}'


def test_strip_json_fences_unwraps_unmarked_block() -> None:
    assert strip_json_fences('```\n{"a":1}\n```') == '{"a":1}'


def test_strip_json_fences_no_op_when_no_fence() -> None:
    assert strip_json_fences('{"a":1}') == '{"a":1}'


# --- summarise_* helpers --------------------------------------------


@pytest.mark.asyncio
async def test_summarise_file_happy_path() -> None:
    client = _FakeClient('{"summary":"s","keyTopics":["a","b"]}')
    out = await summarise_file(client=client, model="m", name="doc", text="hello")
    assert isinstance(out, SummariseOk)
    assert out.payload == {"summary": "s", "keyTopics": ["a", "b"]}


@pytest.mark.asyncio
async def test_summarise_file_strips_json_fences() -> None:
    client = _FakeClient('```json\n{"summary":"x","keyTopics":[]}\n```')
    out = await summarise_file(client=client, model="m", name=None, text="t")
    assert isinstance(out, SummariseOk)
    assert out.payload["summary"] == "x"


@pytest.mark.asyncio
async def test_summarise_file_invalid_json_returns_error() -> None:
    client = _FakeClient("not json at all")
    out = await summarise_file(client=client, model="m", name=None, text="t")
    assert isinstance(out, SummariseError)
    assert out.code == "invalid_json"


@pytest.mark.asyncio
async def test_summarise_file_non_object_json_returns_error() -> None:
    """A JSON array is valid JSON but not a summarisation payload —
    the contract is `{summary, keyTopics}`. Reject."""
    client = _FakeClient("[1, 2, 3]")
    out = await summarise_file(client=client, model="m", name=None, text="t")
    assert isinstance(out, SummariseError)
    assert out.code == "invalid_json"


@pytest.mark.asyncio
async def test_summarise_file_empty_output_returns_provider_error() -> None:
    client = _FakeClient("")
    out = await summarise_file(client=client, model="m", name=None, text="t")
    assert isinstance(out, SummariseError)
    assert out.code == "provider"


@pytest.mark.asyncio
async def test_summarise_file_upstream_exception_returns_provider_error() -> None:
    client = _FakeClient("", raises=RuntimeError("rate limited"))
    out = await summarise_file(client=client, model="m", name=None, text="t")
    assert isinstance(out, SummariseError)
    assert out.code == "provider"
    assert "rate limited" in out.message


@pytest.mark.asyncio
async def test_summarise_conversation_happy_path() -> None:
    client = _FakeClient('{"summary":"s","keyPoints":["k"],"decisions":[]}')
    msgs = [
        ChatMessage(role="user", content="hi"),
        ChatMessage(role="assistant", content="hello"),
    ]
    out = await summarise_conversation(client=client, model="m", messages=msgs)
    assert isinstance(out, SummariseOk)
    assert out.payload["keyPoints"] == ["k"]


@pytest.mark.asyncio
async def test_summarise_compress_returns_recap_text() -> None:
    """Compress mode returns plain markdown, not JSON."""
    client = _FakeClient("- bullet one\n- bullet two")
    out = await summarise_compress(
        client=client,
        model="m",
        messages=[
            ChatMessage(role="user", content="a"),
            ChatMessage(role="assistant", content="b"),
        ],
    )
    assert isinstance(out, SummariseOk)
    assert out.payload == {"recap": "- bullet one\n- bullet two"}


@pytest.mark.asyncio
async def test_summarise_compress_empty_returns_provider_error() -> None:
    client = _FakeClient("   \n   ")
    out = await summarise_compress(
        client=client,
        model="m",
        messages=[
            ChatMessage(role="user", content="a"),
            ChatMessage(role="assistant", content="b"),
        ],
    )
    assert isinstance(out, SummariseError)
    assert out.code == "provider"


@pytest.mark.asyncio
async def test_summarise_project_breakdown_happy_path() -> None:
    client = _FakeClient('{"titles":["task one","task two"]}')
    out = await summarise_project_breakdown(
        client=client, model="m", goal="ship a thing", existing_titles=None
    )
    assert isinstance(out, SummariseOk)
    assert out.payload["titles"] == ["task one", "task two"]


@pytest.mark.asyncio
async def test_summarise_project_breakdown_includes_existing_titles_in_prompt() -> None:
    client = _FakeClient('{"titles":["new task"]}')
    await summarise_project_breakdown(
        client=client,
        model="m",
        goal="ship a thing",
        existing_titles=["already done", "also there"],
    )
    prompt = client.messages.calls[0]["messages"][0]["content"]
    assert "already done" in prompt
    assert "also there" in prompt


# --- /v1/summarize route --------------------------------------------


def test_summarize_rejects_missing_token(client: TestClient) -> None:
    r = client.post("/v1/summarize", json={"mode": "file", "text": "hello"})
    assert r.status_code == 401


def test_summarize_503_when_no_anthropic_key(client: TestClient) -> None:
    with patch.object(main_module, "resolve_anthropic_client", return_value=None):
        r = client.post(
            "/v1/summarize",
            json={"mode": "file", "text": "hello"},
            headers=_auth(),
        )
    assert r.status_code == 503


def test_summarize_rejects_unknown_mode(client: TestClient) -> None:
    r = client.post(
        "/v1/summarize",
        json={"mode": "totally-not-a-mode", "text": "x"},
        headers=_auth(),
    )
    assert r.status_code == 422


def test_summarize_file_happy_path(client: TestClient) -> None:
    fake = _FakeClient('{"summary":"hi","keyTopics":["t"]}')
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/summarize",
            json={"mode": "file", "name": "doc", "text": "hello world"},
            headers=_auth(),
        )
    assert r.status_code == 200
    assert r.json() == {"summary": "hi", "keyTopics": ["t"]}


def test_summarize_conversation_happy_path(client: TestClient) -> None:
    fake = _FakeClient('{"summary":"s","keyPoints":["k"],"decisions":["d"]}')
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/summarize",
            json={
                "mode": "conversation",
                "messages": [
                    {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": "hello"},
                ],
            },
            headers=_auth(),
        )
    assert r.status_code == 200
    body = r.json()
    assert body["keyPoints"] == ["k"]


def test_summarize_compress_returns_recap(client: TestClient) -> None:
    fake = _FakeClient("- one\n- two")
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/summarize",
            json={
                "mode": "compress",
                "messages": [
                    {"role": "user", "content": "first"},
                    {"role": "assistant", "content": "second"},
                ],
            },
            headers=_auth(),
        )
    assert r.status_code == 200
    assert r.json() == {"recap": "- one\n- two"}


def test_summarize_project_breakdown_accepts_existing_titles_alias(
    client: TestClient,
) -> None:
    """Body uses camelCase `existingTitles` (matches the TS wire);
    pydantic alias deserialises it."""
    fake = _FakeClient('{"titles":["t1","t2"]}')
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/summarize",
            json={
                "mode": "project-breakdown",
                "goal": "ship a thing",
                "existingTitles": ["existing"],
            },
            headers=_auth(),
        )
    assert r.status_code == 200
    assert r.json()["titles"] == ["t1", "t2"]


def test_summarize_provider_error_returns_502(client: TestClient) -> None:
    fake = _FakeClient("", raises=RuntimeError("upstream blew up"))
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/summarize",
            json={"mode": "file", "text": "x"},
            headers=_auth(),
        )
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert detail["code"] == "provider"


def test_summarize_invalid_json_response_returns_502(client: TestClient) -> None:
    fake = _FakeClient("this is not json")
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/summarize",
            json={"mode": "file", "text": "x"},
            headers=_auth(),
        )
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_json"


def test_summarize_falls_back_to_default_model(client: TestClient) -> None:
    """Body sends a non-Anthropic id; route resolves to Haiku."""
    fake = _FakeClient('{"summary":"s","keyTopics":[]}')
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/summarize",
            json={
                "mode": "file",
                "text": "x",
                "model": "google/gemini-2.5-flash",
            },
            headers=_auth(),
        )
    assert r.status_code == 200
    # The fake captured the model arg the route passed to Anthropic.
    assert fake.messages.calls[0]["model"] == DEFAULT_SUMMARY_MODEL


def test_summarize_anthropic_model_passes_through(client: TestClient) -> None:
    fake = _FakeClient('{"summary":"s","keyTopics":[]}')
    with patch.object(main_module, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/summarize",
            json={
                "mode": "file",
                "text": "x",
                "model": "claude-3-5-sonnet-20241022",
            },
            headers=_auth(),
        )
    assert r.status_code == 200
    assert fake.messages.calls[0]["model"] == "claude-3-5-sonnet-20241022"


def test_summarize_rejects_too_long_text(client: TestClient) -> None:
    r = client.post(
        "/v1/summarize",
        json={"mode": "file", "text": "x" * 50_001},
        headers=_auth(),
    )
    assert r.status_code == 422


def test_summarize_compress_requires_two_messages(client: TestClient) -> None:
    r = client.post(
        "/v1/summarize",
        json={
            "mode": "compress",
            "messages": [{"role": "user", "content": "alone"}],
        },
        headers=_auth(),
    )
    assert r.status_code == 422
