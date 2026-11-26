"""`GET /v1/models` (wave 10, Q119): the catalog ids this deploy has a
provider for, in catalog order, with whether tasks run on them."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agent_py.main import create_app
from agent_py.model_allowlist import get_model_allowlist
from agent_py.settings import get_settings

KEYS = (
    "ANTHROPIC_API_KEY",
    "AI_GATEWAY_API_KEY",
    "OPENROUTER_API_KEY",
    "MINIMAX_CN_API_KEY",
    "MINIMAX_CN_BASE_URL",
    "OLLAMA_BASE_URL",
)


def _get(monkeypatch: pytest.MonkeyPatch, **env: str) -> dict[str, object]:
    for key in KEYS:
        monkeypatch.setenv(key, env.get(key, ""))
    get_settings.cache_clear()
    get_model_allowlist.cache_clear()
    with TestClient(create_app(enable_poller=False)) as client:
        r = client.get("/v1/models")  # no bearer token: public
    assert r.status_code == 200
    body: dict[str, object] = r.json()
    return body


def test_no_provider_no_models(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _get(monkeypatch) == {
        "models": [],
        "defaultModel": "anthropic/claude-haiku-4.5",
        "auto": False,
    }


def test_anthropic_and_minimax(monkeypatch: pytest.MonkeyPatch) -> None:
    body = _get(
        monkeypatch,
        ANTHROPIC_API_KEY="k",
        MINIMAX_CN_API_KEY="m",
        MINIMAX_CN_BASE_URL="https://api.minimaxi.com/anthropic/v1",
    )
    assert body["models"] == [
        {"id": "anthropic/claude-sonnet-4.6", "tasks": True},
        {"id": "anthropic/claude-haiku-4.5", "tasks": True},
        {"id": "minimax/minimax-m2.7", "tasks": True},
        {"id": "minimax/minimax-m3.1-flash", "tasks": True},
        {"id": "minimax/minimax-m3", "tasks": True},
    ]
    assert body["auto"] is True  # the routing pair is Sonnet + Haiku


def test_a_model_without_tools_is_served_but_not_for_tasks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: object
) -> None:
    import json
    from pathlib import Path

    from agent_py.model_allowlist import find_models_config

    catalog = Path(str(tmp_path)) / "models.json"
    raw = json.loads(Path(str(find_models_config())).read_text())
    for m in raw["models"]:
        if m["id"] == "minimax/minimax-m2.7":
            m["supportsTools"] = False
    catalog.write_text(json.dumps(raw))
    (Path(str(tmp_path)) / "providers.json").write_text(
        (Path(str(find_models_config())).parent / "providers.json").read_text()
    )
    monkeypatch.setenv("MODELS_CONFIG_PATH", str(catalog))
    body = _get(
        monkeypatch,
        MINIMAX_CN_API_KEY="m",
        MINIMAX_CN_BASE_URL="https://api.minimaxi.com/anthropic/v1",
    )
    assert {"id": "minimax/minimax-m2.7", "tasks": False} in body["models"]  # type: ignore[operator]
    assert body["auto"] is False
