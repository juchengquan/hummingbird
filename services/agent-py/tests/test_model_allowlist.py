"""Model allowlist — every `config/models.json` id is accepted (wave 10);
an `anthropic/*` one maps to its Anthropic API id on the direct route.

Covers: the mapping (explicit `anthropicModelId` + prefix-strip
fallback), unknown ids → 400 `unknown_model` on `/v1/runs`, a tampered
run checkpoint failing the run before Anthropic is called, and the
boot-time check of `AGENT_DEFAULT_MODEL` / the catalog path.
"""

from __future__ import annotations

import json
import time
import uuid
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
from agent_py.runs import native_harness, wiring
from agent_py.runs.wiring import build_run_services
from agent_py.settings import Settings

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
RUN_ID = "11111111-1111-1111-1111-111111111111"
USER_ID = "22222222-2222-2222-2222-222222222222"


# --- mapping ----------------------------------------------------------------


def test_repo_catalog_is_found() -> None:
    path = find_models_config()
    assert path is not None
    assert path.parts[-2:] == ("config", "models.json")


def test_catalog_is_the_file_the_web_app_bundles() -> None:
    """Q153: agent-py and the web app (`apps/web`, `@config/*` →
    `../../config/*`) read one catalog, the repo root's."""
    repo = Path(__file__).resolve().parents[3]
    tsconfig = json.loads((repo / "apps" / "web" / "tsconfig.json").read_text())
    (alias,) = tsconfig["compilerOptions"]["paths"]["@config/*"]
    web_catalog = (repo / "apps" / "web" / alias.replace("*", "models.json")).resolve()
    path = find_models_config()
    assert path is not None
    assert path.resolve() == web_catalog == repo / "config" / "models.json"


def test_allowed_catalog_ids_map_to_api_ids() -> None:
    assert resolve_api_model_id("anthropic/claude-sonnet-4.6") == "claude-sonnet-4-6"
    assert resolve_api_model_id("anthropic/claude-haiku-4.5") == "claude-haiku-4-5"


def test_every_catalog_id_is_accepted() -> None:
    """Wave 10 (Q109): the other providers' models are accepted too; without a
    provider for them here they are valid ids that can't run (503 at call)."""
    allowlist = get_model_allowlist()
    assert resolve_api_model_id("deepseek/deepseek-v4-flash") == "deepseek/deepseek-v4-flash"
    assert resolve_api_model_id("openrouter/anthropic/claude-sonnet-4.5") == (
        "anthropic/claude-sonnet-4.5"
    )
    assert not allowlist.available("deepseek/deepseek-v4-flash")


@pytest.mark.parametrize(
    "model_id",
    [
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
        "openai/gpt-x": "openai/gpt-x",
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
    assert allowlist.structured_output == frozenset({"anthropic/a", "openai/x"})
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


@pytest.mark.parametrize("default", ["deepseek/deepseek-v9", "claude-haiku-4-5"])
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


def test_an_empty_catalog_fails(tmp_path: Path) -> None:
    path = tmp_path / "models.json"
    path.write_text(json.dumps({"models": []}))
    with pytest.raises(ModelConfigError, match="no models"):
        load_allowlist(path, default_model="openai/gpt-x")


# --- /v1/runs ---------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The runs router over the in-memory store and the native harness
    (the real model path, its client patched per test)."""
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    services = build_run_services(Settings(SUPABASE_JWT_SECRET=SECRET), None)
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    return TestClient(app)


def _run_body(model: str) -> dict[str, Any]:
    return {
        "threadId": str(uuid.uuid4()),
        "runId": str(uuid.uuid4()),
        "messages": [{"id": "m1", "role": "user", "content": "hi"}],
        "forwardedProps": {"model": model},
    }


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


def test_run_maps_allowed_model_to_api_id(client: TestClient) -> None:
    fake = _RecordingClient()
    with patch.object(native_harness, "client_for_target", return_value=fake):
        r = client.post("/v1/runs", json=_run_body("anthropic/claude-sonnet-4.6"), headers=_auth())
    assert r.status_code == 200
    assert fake.calls, "the run never reached the client"
    assert fake.calls[0]["model"] == "claude-sonnet-4-6"


@pytest.mark.parametrize("model", ["deepseek/deepseek-v9", "claude-3-5-sonnet-20241022"])
def test_run_rejects_unlisted_model(client: TestClient, model: str) -> None:
    fake = _RecordingClient()
    with patch.object(native_harness, "client_for_target", return_value=fake):
        r = client.post("/v1/runs", json=_run_body(model), headers=_auth())
    assert r.status_code == 400
    detail = r.json()
    assert detail["code"] == "unknown_model"
    assert model in detail["message"]
    assert fake.calls == []


def test_run_unknown_model_is_400_even_without_api_key(client: TestClient) -> None:
    """Allowlist runs before the provider check."""
    with patch.object(native_harness, "client_for_target", return_value=None):
        r = client.post("/v1/runs", json=_run_body("nope"), headers=_auth())
    assert r.status_code == 400
    assert r.json()["code"] == "unknown_model"


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
