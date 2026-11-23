"""Model allowlist — `config/models.json`'s `anthropic/*` entries are the
only ids the service accepts; each maps to its Anthropic API id.

Covers: the mapping (explicit `anthropicModelId` + prefix-strip
fallback), unknown ids → 400 `unknown_model` on `/v1/chat`, a tampered
run checkpoint failing the run before Anthropic is called, and the
boot-time check of `AGENT_DEFAULT_MODEL` / the catalog path.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import executor, store
from agent_py.executor import StartActionPayload, execute_start
from agent_py.main import create_app
from agent_py.model_allowlist import (
    ModelConfigError,
    UnknownModelError,
    find_models_config,
    get_model_allowlist,
    load_allowlist,
    parse_allowlist,
    resolve_api_model_id,
    resolve_optional_model,
)
from agent_py.routers import chat as chat_router

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
RUN_ID = "11111111-1111-1111-1111-111111111111"
USER_ID = "22222222-2222-2222-2222-222222222222"


# --- mapping ----------------------------------------------------------------


def test_repo_catalog_is_found() -> None:
    path = find_models_config()
    assert path is not None
    assert path.parts[-2:] == ("config", "models.json")


def test_allowed_catalog_ids_map_to_api_ids() -> None:
    assert resolve_api_model_id("anthropic/claude-sonnet-4.6") == "claude-sonnet-4-6"
    assert resolve_api_model_id("anthropic/claude-haiku-4.5") == "claude-haiku-4-5"


@pytest.mark.parametrize(
    "model_id",
    [
        "deepseek/deepseek-v4-flash",  # in the catalog, but not anthropic/*
        "openrouter/anthropic/claude-sonnet-4.5",
        "claude-sonnet-4-6",  # a raw API id is not a catalog id
        "anthropic/claude-opus-9",
        "",
    ],
)
def test_unlisted_ids_are_rejected(model_id: str) -> None:
    with pytest.raises(UnknownModelError) as exc_info:
        resolve_api_model_id(model_id)
    assert exc_info.value.to_detail()["code"] == "unknown_model"


def test_optional_model_defaults_to_agent_default_model() -> None:
    assert resolve_optional_model(None) == "claude-haiku-4-5"
    assert resolve_optional_model("") == "claude-haiku-4-5"
    assert resolve_optional_model("anthropic/claude-sonnet-4.6") == "claude-sonnet-4-6"


def test_explicit_field_wins_and_prefix_strip_is_the_fallback() -> None:
    allowlist = parse_allowlist(
        {
            "models": [
                {"id": "anthropic/a.1", "anthropicModelId": "claude-a-1"},
                {"id": "anthropic/claude-b"},
                {"id": "openai/gpt-x"},
            ]
        },
        default_model="anthropic/a.1",
    )
    assert dict(allowlist.api_ids) == {
        "anthropic/a.1": "claude-a-1",
        "anthropic/claude-b": "claude-b",
    }


def test_structured_output_flag_is_read_from_the_catalog() -> None:
    """`supportsStructuredOutput: true` marks a model for the native
    structured path (`/v1/extract-table`); absent / non-true → not."""
    allowlist = parse_allowlist(
        {
            "models": [
                {"id": "anthropic/a", "supportsStructuredOutput": True},
                {"id": "anthropic/b", "supportsStructuredOutput": "yes"},
                {"id": "anthropic/c"},
                {"id": "openai/x", "supportsStructuredOutput": True},
            ]
        },
        default_model="anthropic/c",
    )
    assert allowlist.structured_output == frozenset({"anthropic/a"})
    assert allowlist.supports_structured_output("anthropic/a") is True
    assert allowlist.supports_structured_output("anthropic/b") is False
    # Absent → the default model's flag.
    assert allowlist.supports_structured_output(None) is False
    assert get_model_allowlist().supports_structured_output("anthropic/claude-haiku-4.5")


def test_reasoning_effort_flag_is_read_from_the_catalog() -> None:
    """`supportsReasoningEffort: true` marks a model that takes a
    reasoning tier (`forwardedProps.reasoningEffort` on runs)."""
    allowlist = parse_allowlist(
        {
            "models": [
                {"id": "anthropic/a", "supportsReasoningEffort": True},
                {"id": "anthropic/b", "supportsReasoningEffort": 1},
                {"id": "anthropic/c"},
            ]
        },
        default_model="anthropic/a",
    )
    assert allowlist.reasoning_effort == frozenset({"anthropic/a"})
    assert allowlist.supports_reasoning_effort("anthropic/b") is False
    assert allowlist.supports_reasoning_effort(None) is True  # the default's flag
    # Both served models take one in the real catalog.
    real = get_model_allowlist()
    assert real.supports_reasoning_effort("anthropic/claude-sonnet-4.6")
    assert real.supports_reasoning_effort("anthropic/claude-haiku-4.5")


# --- boot-time validation ---------------------------------------------------


@pytest.mark.parametrize("default", ["deepseek/deepseek-v4-flash", "claude-haiku-4-5"])
def test_default_outside_allowlist_fails_boot(
    monkeypatch: pytest.MonkeyPatch, default: str
) -> None:
    monkeypatch.setenv("AGENT_DEFAULT_MODEL", default)
    with pytest.raises(ModelConfigError, match="AGENT_DEFAULT_MODEL"):
        create_app(enable_poller=False)


def test_allowed_default_override_is_honoured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_DEFAULT_MODEL", "anthropic/claude-sonnet-4.6")
    create_app(enable_poller=False)
    assert get_model_allowlist().default_api_id == "claude-sonnet-4-6"


def test_empty_default_falls_back_to_builtin(monkeypatch: pytest.MonkeyPatch) -> None:
    """`AGENT_DEFAULT_MODEL=` (as copied from .env.example) is not a
    boot failure — it means "use the default"."""
    monkeypatch.setenv("AGENT_DEFAULT_MODEL", "")
    create_app(enable_poller=False)
    assert get_model_allowlist().default_api_id == "claude-haiku-4-5"


def test_missing_catalog_fails_boot(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MODELS_CONFIG_PATH", str(tmp_path / "nope.json"))
    with pytest.raises(ModelConfigError, match="cannot read"):
        create_app(enable_poller=False)


def test_catalog_without_anthropic_models_fails(tmp_path: Path) -> None:
    path = tmp_path / "models.json"
    path.write_text(json.dumps({"models": [{"id": "openai/gpt-x"}]}))
    with pytest.raises(ModelConfigError, match="no anthropic"):
        load_allowlist(path, default_model="openai/gpt-x")


# --- /v1/chat ---------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    chat_router._reset_chat_per_ip_limit_for_test()
    return TestClient(create_app(enable_poller=False))


def _auth() -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": "00000000-0000-4000-8000-0000000000aa",
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        },
        SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


class _RecordingStream:
    async def __aenter__(self) -> _RecordingStream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[Any]:
        return self._events()

    async def _events(self) -> AsyncIterator[Any]:
        return
        yield  # pragma: no cover

    @property
    def text_stream(self) -> AsyncIterator[str]:
        return self._events()

    async def get_final_message(self) -> dict[str, Any]:
        return {"content": []}


class _RecordingClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.messages = self

    def stream(self, **kwargs: Any) -> _RecordingStream:
        self.calls.append(kwargs)
        return _RecordingStream()


def test_chat_maps_allowed_model_to_api_id(client: TestClient) -> None:
    fake = _RecordingClient()
    with patch.object(chat_router, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/chat",
            json={
                "model": "anthropic/claude-sonnet-4.6",
                "messages": [{"role": "user", "content": "hi"}],
            },
            headers=_auth(),
        )
    assert r.status_code == 200
    assert fake.calls, "chat turn never reached the client"
    assert fake.calls[0]["model"] == "claude-sonnet-4-6"


@pytest.mark.parametrize("model", ["deepseek/deepseek-v4-flash", "claude-3-5-sonnet-20241022"])
def test_chat_rejects_unlisted_model(client: TestClient, model: str) -> None:
    fake = _RecordingClient()
    with patch.object(chat_router, "resolve_anthropic_client", return_value=fake):
        r = client.post(
            "/v1/chat",
            json={"model": model, "messages": [{"role": "user", "content": "hi"}]},
            headers=_auth(),
        )
    assert r.status_code == 400
    detail = r.json()
    assert detail["code"] == "unknown_model"
    assert model in detail["message"]
    assert fake.calls == []


def test_chat_unknown_model_is_400_even_without_api_key(client: TestClient) -> None:
    """Allowlist runs before the provider check, like the Next.js route."""
    with patch.object(chat_router, "resolve_anthropic_client", return_value=None):
        r = client.post(
            "/v1/chat",
            json={"model": "nope", "messages": [{"role": "user", "content": "hi"}]},
            headers=_auth(),
        )
    assert r.status_code == 400


# --- executor: checkpoint re-validation -------------------------------------


def _checkpoint(model: str) -> dict[str, Any]:
    return {
        "messages": [{"role": "user", "content": "hi"}],
        "step": 0,
        "seq": 1,
        "config": {"model": model},
    }


@pytest.mark.asyncio
async def test_tampered_checkpoint_model_fails_run_before_anthropic() -> None:
    """`tasks.checkpoint` is owner-writable under RLS: a model id swapped
    in after `/api/tasks` validated it must fail the run cleanly — a
    terminal `failed` settle with a clear error — and never reach
    Anthropic."""
    fake = _RecordingClient()
    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()) as append,
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(
            store, "load_checkpoint", new=AsyncMock(return_value=_checkpoint("claude-opus-4-8"))
        ),
        patch.object(executor, "_resolve_anthropic_client", return_value=fake),
        patch(
            "agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())
        ) as settle,
    ):
        outcome = await execute_start(
            MagicMock(), StartActionPayload(run_id=RUN_ID, user_id=USER_ID, max_steps=5)
        )
    assert outcome.settled is False
    assert outcome.error is not None
    assert 'Unknown model "claude-opus-4-8"' in outcome.error
    assert fake.calls == []
    settle.assert_awaited()
    assert settle.await_args is not None
    assert settle.await_args.kwargs["status"] == "failed"
    # A terminal `result: failed` event carries the error to the UI.
    event = settle.await_args.kwargs["event"]
    assert event.kind == "result" and "claude-opus-4-8" in event.error
    assert event.error_code == "unknown_model"
    # The settle wrote it, in its transaction: nothing separately.
    assert "result" not in [call.args[1].kind for call in append.await_args_list]


def test_checkpoint_model_is_mapped_for_the_step_fn() -> None:
    captured: dict[str, Any] = {}

    def fake_make(config: Any) -> Any:
        captured["model"] = config.model
        return MagicMock()

    with (
        patch.object(executor, "_resolve_anthropic_client", return_value=_RecordingClient()),
        patch.object(executor, "make_anthropic_step_fn", side_effect=fake_make),
    ):
        executor._default_make_step_fn(
            StartActionPayload(run_id=RUN_ID, user_id=USER_ID, max_steps=5),
            _checkpoint("anthropic/claude-sonnet-4.6"),
            [{"role": "user", "content": "hi"}],
        )
    assert captured["model"] == "claude-sonnet-4-6"
