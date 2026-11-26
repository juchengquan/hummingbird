"""Which provider serves each catalog model (wave 10, Q114 / Q115 / Q117 / Q118).

The providers come from `config/providers.json` and the environment
variables it names; a model takes Anthropic directly when it is an
`anthropic/*` model and `ANTHROPIC_API_KEY` is set, else its first catalog
route with a configured provider. Real SDK clients for the credential checks.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_py import model_routes
from agent_py.model_allowlist import (
    find_models_config,
    get_model_allowlist,
    parse_allowlist,
)
from agent_py.model_routes import (
    GATEWAY_BASE_URL,
    ModelTarget,
    Provider,
    ProviderConfigError,
    client_for,
    configured_providers,
    route_model,
)
from agent_py.settings import Settings, get_settings

PROVIDERS_JSON: dict[str, Any] = json.loads(
    (Path(str(find_models_config())).parent / "providers.json").read_text()
)
KEYS = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "AI_GATEWAY_API_KEY",
    "OPENROUTER_API_KEY",
    "MINIMAX_CN_API_KEY",
    "MINIMAX_CN_BASE_URL",
    "OLLAMA_BASE_URL",
    "OLLAMA_API_KEY",
)


@pytest.fixture(autouse=True)
def _no_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in KEYS:
        monkeypatch.setenv(key, "")


def _settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> Settings:
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    get_model_allowlist.cache_clear()
    return get_settings()


# --- providers --------------------------------------------------------------


def test_no_keys_no_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    assert configured_providers(PROVIDERS_JSON, _settings(monkeypatch)) == {}


def test_each_provider_in_the_messages_format(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(
        monkeypatch,
        ANTHROPIC_API_KEY="sk-ant",
        AI_GATEWAY_API_KEY="gw",
        OPENROUTER_API_KEY="or",
        MINIMAX_CN_API_KEY="mm",
        MINIMAX_CN_BASE_URL="https://api.minimaxi.com/anthropic/v1/",
        OLLAMA_BASE_URL="http://localhost:11434/v1",
    )
    assert configured_providers(PROVIDERS_JSON, settings) == {
        "anthropic": Provider("anthropic", "https://api.anthropic.com", api_key="sk-ant"),
        "gateway": Provider("gateway", GATEWAY_BASE_URL, auth_token="gw"),
        # `…/anthropic/v1` is the AI SDK's base; the Python SDK adds `/v1` itself.
        "minimax-cn": Provider("minimax-cn", "https://api.minimaxi.com/anthropic", api_key="mm"),
        "openrouter": Provider("openrouter", "https://openrouter.ai/api", auth_token="or"),
        # Ollama takes no key (`allowInsecureBaseUrl`, as on Next).
        "ollama": Provider("ollama", "http://localhost:11434", auth_token="ollama"),
    }


def test_anthropic_base_url_override(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(
        monkeypatch, ANTHROPIC_API_KEY="k", ANTHROPIC_BASE_URL=" https://p.example "
    )
    assert configured_providers({}, settings)["anthropic"].base_url == "https://p.example"


@pytest.mark.parametrize(
    ("env", "missing"),
    [
        ({"MINIMAX_CN_API_KEY": "mm"}, "minimax-cn"),  # no URL
        ({"MINIMAX_CN_BASE_URL": "https://api.minimaxi.com/anthropic/v1"}, "minimax-cn"),  # no key
    ],
)
def test_a_half_configured_provider_is_skipped(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], missing: str
) -> None:
    assert missing not in configured_providers(PROVIDERS_JSON, _settings(monkeypatch, **env))


def test_an_openai_provider_needs_a_key_unless_it_is_a_local_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw = {"hosted": {"type": "openai", "baseURL": "https://h.example/v1", "apiKeyEnv": "NOPE_KEY"}}
    assert configured_providers(raw, _settings(monkeypatch)) == {}


@pytest.mark.parametrize(
    "raw",
    [
        # Only a provider marked `allowInsecureBaseUrl` may use http.
        {
            "x": {
                "type": "openai",
                "baseURL": "http://h.example/v1",
                "apiKeyEnv": "AI_GATEWAY_API_KEY",
            }
        },
        {
            "x": {
                "type": "anthropic",
                "baseURL": "ftp://h.example",
                "apiKeyEnv": "AI_GATEWAY_API_KEY",
            }
        },
        {"x": {"type": "bedrock", "apiKeyEnv": "AI_GATEWAY_API_KEY"}},
        {"x": "not an object"},
    ],
)
def test_a_bad_provider_fails_boot(monkeypatch: pytest.MonkeyPatch, raw: dict[str, Any]) -> None:
    with pytest.raises(ProviderConfigError):
        configured_providers(raw, _settings(monkeypatch, AI_GATEWAY_API_KEY="gw"))


# --- routes -----------------------------------------------------------------

HAIKU = {
    "id": "anthropic/claude-haiku-4.5",
    "anthropicModelId": "claude-haiku-4-5",
    "routes": [{"via": "gateway"}],
}
MINIMAX = {
    "id": "minimax/minimax-m3",
    "routes": [{"via": "minimax-cn", "upstreamId": "MiniMax-M3"}, {"via": "gateway"}],
}
OPENROUTER = {
    "id": "openrouter/openai/gpt-5",
    "routes": [{"via": "openrouter", "upstreamId": "openai/gpt-5", "fallbacks": ["a/b", "c/d"]}],
}
DIRECT = Provider("anthropic", "https://api.anthropic.com", api_key="k")
GATEWAY = Provider("gateway", GATEWAY_BASE_URL, auth_token="g")
MM = Provider("minimax-cn", "https://api.minimaxi.com/anthropic", api_key="m")


def test_an_anthropic_model_goes_direct_when_its_key_is_set() -> None:
    """Q115, even when the Gateway is configured too."""
    providers = {"anthropic": DIRECT, "gateway": GATEWAY}
    assert route_model(HAIKU, providers) == ModelTarget(
        "anthropic/claude-haiku-4.5", "claude-haiku-4-5", "anthropic"
    )


def test_without_the_anthropic_key_it_takes_its_catalog_route() -> None:
    assert route_model(HAIKU, {"gateway": GATEWAY}) == ModelTarget(
        "anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4.5", "gateway"
    )


def test_the_first_configured_route_wins() -> None:
    both = {"gateway": GATEWAY, "minimax-cn": MM}
    assert route_model(MINIMAX, both) == ModelTarget(
        "minimax/minimax-m3", "MiniMax-M3", "minimax-cn"
    )
    assert route_model(MINIMAX, {"gateway": GATEWAY}) == ModelTarget(
        "minimax/minimax-m3", "minimax/minimax-m3", "gateway"
    )


def test_openrouter_fallbacks_ride_along() -> None:
    target = route_model(
        OPENROUTER, {"openrouter": Provider("openrouter", "https://o", auth_token="o")}
    )
    assert (target.api_id, target.fallbacks) == ("openai/gpt-5", ("a/b", "c/d"))


def test_with_no_provider_the_model_keeps_its_ids_and_is_unavailable() -> None:
    assert route_model(HAIKU, {}) == ModelTarget(
        "anthropic/claude-haiku-4.5", "claude-haiku-4-5", None
    )
    assert route_model(MINIMAX, {}) == ModelTarget("minimax/minimax-m3", "MiniMax-M3", None)
    assert not route_model(MINIMAX, {}).available


def test_the_repo_catalog_on_minimax_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deploy this wave was checked on: only a Minimax key."""
    _settings(
        monkeypatch,
        MINIMAX_CN_API_KEY="mm",
        MINIMAX_CN_BASE_URL="https://api.minimaxi.com/anthropic/v1",
    )
    allowlist = get_model_allowlist()
    served = {m for m in allowlist.targets if allowlist.available(m)}
    assert served == {m for m, t in allowlist.targets.items() if t.provider == "minimax-cn"}
    assert "minimax/minimax-m3.1-flash" in served
    assert allowlist.target("minimax/minimax-m3.1-flash").api_id == "MiniMax-M3.1-Flash"
    assert not allowlist.available("anthropic/claude-haiku-4.5")


# --- clients ----------------------------------------------------------------


def test_a_gateway_client_never_carries_the_anthropic_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "other-secret")
    client = client_for(GATEWAY)
    assert client.api_key is None
    assert client.auth_token == "g"
    assert str(client.base_url).rstrip("/") == GATEWAY_BASE_URL
    assert client.auth_headers == {"Authorization": "Bearer g"}


def test_a_minimax_client_sends_its_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "other-secret")
    client = client_for(MM)
    assert client.auth_headers == {"X-Api-Key": "m"}
    assert str(client.base_url).rstrip("/") == "https://api.minimaxi.com/anthropic"


def test_one_client_per_provider() -> None:
    assert client_for(MM) is client_for(MM)
    assert client_for(MM) is not client_for(GATEWAY)
    assert client_for(None) is None
    model_routes.reset_clients()
    assert client_for(MM) is not None


# --- the allowlist on targets -------------------------------------------------

CATALOG = {
    "models": [
        {**HAIKU, "supportsStructuredOutput": True},
        MINIMAX,
        {"id": "ollama/tiny", "supportsTools": False, "routes": [{"via": "gateway"}]},
        {"id": "google/g", "supportsStructuredOutput": True, "routes": [{"via": "nowhere"}]},
    ],
    "routing": {"strong": "minimax/minimax-m3", "weak": "anthropic/claude-haiku-4.5"},
}


def test_availability_tasks_and_auto() -> None:
    allowlist = parse_allowlist(
        CATALOG,
        default_model="anthropic/claude-haiku-4.5",
        providers={"anthropic": DIRECT, "gateway": GATEWAY, "minimax-cn": MM},
    )
    assert allowlist.available("minimax/minimax-m3")
    assert not allowlist.available("google/g")
    assert not allowlist.available("not/in-catalog")
    # Q117: tasks need a provider and tools.
    assert allowlist.runs_tasks("minimax/minimax-m3")
    assert not allowlist.runs_tasks("ollama/tiny")
    assert not allowlist.runs_tasks("google/g")
    assert not allowlist.supports_tools("ollama/tiny")
    # Q118: `auto` across providers, when both are served.
    assert allowlist.auto_available()
    no_mm = parse_allowlist(
        CATALOG, default_model="anthropic/claude-haiku-4.5", providers={"anthropic": DIRECT}
    )
    assert no_mm.routing is not None and not no_mm.auto_available()


def test_a_forced_tool_call_goes_to_a_model_with_structured_output() -> None:
    """Q116: Minimax answers a forced `tool_choice` in text (wave-10 probe)."""
    allowlist = parse_allowlist(
        CATALOG,
        default_model="anthropic/claude-haiku-4.5",
        providers={"anthropic": DIRECT, "minimax-cn": MM},
    )
    assert allowlist.structured_target("minimax/minimax-m3") == allowlist.default_target
    assert allowlist.structured_target(None) == allowlist.default_target
    assert allowlist.structured_target("anthropic/claude-haiku-4.5").catalog_id == (
        "anthropic/claude-haiku-4.5"
    )


def test_the_allowlist_hands_out_each_targets_client() -> None:
    allowlist = parse_allowlist(
        CATALOG,
        default_model="anthropic/claude-haiku-4.5",
        providers={"anthropic": DIRECT, "minimax-cn": MM},
    )
    assert allowlist.client(allowlist.target("minimax/minimax-m3")) is client_for(MM)
    assert allowlist.client(allowlist.default_target) is client_for(DIRECT)
    assert allowlist.client(allowlist.target("google/g")) is None


async def test_openrouter_backups_go_with_every_call() -> None:
    """Q118: a route's `fallbacks` reach OpenRouter as its `models` list."""
    sent: list[dict[str, Any]] = []

    class _Messages:
        async def create(self, **kw: Any) -> str:
            sent.append(kw)
            return "created"

        def stream(self, **kw: Any) -> str:
            sent.append(kw)
            return "streamed"

    class _Client:
        messages = _Messages()

    openrouter = Provider("openrouter", "https://openrouter.ai/api", auth_token="o")
    allowlist = parse_allowlist(
        {"models": [OPENROUTER, HAIKU]},
        default_model="anthropic/claude-haiku-4.5",
        providers={"openrouter": openrouter, "anthropic": DIRECT},
    )
    model_routes._clients[openrouter] = _Client()
    client = allowlist.client(allowlist.target("openrouter/openai/gpt-5"))
    assert await client.messages.create(model="openai/gpt-5", max_tokens=1) == "created"
    assert client.messages.stream(model="openai/gpt-5", extra_body={"x": 1}) == "streamed"
    assert sent == [
        {"model": "openai/gpt-5", "max_tokens": 1, "extra_body": {"models": ["a/b", "c/d"]}},
        {"model": "openai/gpt-5", "extra_body": {"x": 1, "models": ["a/b", "c/d"]}},
    ]
    # A model without backups gets the provider's client as it is.
    assert allowlist.client(allowlist.default_target) is client_for(DIRECT)
