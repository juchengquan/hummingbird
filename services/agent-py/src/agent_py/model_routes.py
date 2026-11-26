"""Which provider serves each catalog model (wave 10, Q114 / Q115).

agent-py speaks one wire format, Anthropic's Messages API, to every
provider the Next.js app uses: the Vercel AI Gateway (`/v1/messages`),
OpenRouter (`/api/v1/messages`), Ollama (≥ 0.14) and Minimax (an
`"anthropic"` provider already). So a model is served by one Anthropic SDK
client pointed at its provider, with the id that provider knows it by.

The providers come from `config/providers.json` (the file Next reads), their
keys and URLs from the environment variables it names (`apiKeyEnv`,
`baseURLEnv`). A model's route is the catalog's `routes` in order, the first
whose provider is configured, as `lib/server/model-provider.ts` picks it,
with one addition (Q115): an `anthropic/*` model goes to Anthropic directly
when `ANTHROPIC_API_KEY` is set (`anthropicModelId` as its id).

Credentials are always explicit (`anthropic_client.py`): a client for the
Gateway never falls back to the `ANTHROPIC_API_KEY` in the environment.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .anthropic_client import ANTHROPIC_DEFAULT_BASE_URL, make_anthropic_client
from .settings import Settings

#: The pseudo-provider of Q115: Anthropic's API (or `ANTHROPIC_BASE_URL`).
ANTHROPIC_DIRECT = "anthropic"
ANTHROPIC_PREFIX = "anthropic/"
#: The Gateway's Anthropic-format host (its `/v1/messages`).
GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh"


class ProviderConfigError(RuntimeError):
    """`config/providers.json` is malformed, or a configured provider's URL
    is unusable. Raised at boot."""


@dataclass(frozen=True)
class Provider:
    """A configured provider, in the Anthropic Messages format."""

    name: str
    base_url: str
    api_key: str | None = None
    """Sent as `X-Api-Key` (Anthropic, Minimax)."""
    auth_token: str | None = None
    """Sent as `Authorization: Bearer` (the Gateway, OpenRouter, Ollama)."""


@dataclass(frozen=True)
class ModelTarget:
    """Where a catalog model's calls go."""

    catalog_id: str
    api_id: str
    """The id its provider knows it by (`upstreamId`, `anthropicModelId`)."""
    provider: str | None
    """The configured provider serving it; None → no provider for it here
    (calls fail `unavailable`, as without a key before wave 10)."""
    fallbacks: tuple[str, ...] = field(default=())
    """OpenRouter's backup models, sent as its `models` list (Q118)."""

    @property
    def available(self) -> bool:
        return self.provider is not None


def _env(settings: Settings, name: str) -> str:
    """A variable named by `providers.json`: the settings field when there is
    one (it reads `.env`), else the process environment."""
    value = getattr(settings, name, None)
    if not isinstance(value, str):
        value = os.environ.get(name, "")
    return value.strip()


def _messages_base(url: str) -> str:
    """The Messages-format base of an `…/v1` URL (the SDK adds `/v1/messages`)."""
    url = url.rstrip("/")
    return url[: -len("/v1")] if url.endswith("/v1") else url


def _check_url(name: str, url: str, *, allow_insecure: bool) -> None:
    parts = urlsplit(url)
    secure = parts.scheme == "https" or (parts.scheme == "http" and allow_insecure)
    if secure and parts.hostname:
        return
    raise ProviderConfigError(
        f'provider "{name}": base URL must be https'
        + (" (or http with allowInsecureBaseUrl)" if not allow_insecure else "")
        + f", got {url!r}"
    )


def configured_providers(raw: Mapping[str, Any], settings: Settings) -> dict[str, Provider]:
    """The providers this deploy has keys (and URLs) for. Pure but for the
    environment lookups; `raw` is the parsed `providers.json`."""
    out: dict[str, Provider] = {}
    anthropic_key = settings.ANTHROPIC_API_KEY.strip()
    if anthropic_key:
        out[ANTHROPIC_DIRECT] = Provider(
            ANTHROPIC_DIRECT,
            base_url=settings.ANTHROPIC_BASE_URL.strip() or ANTHROPIC_DEFAULT_BASE_URL,
            api_key=anthropic_key,
        )
    for name, cfg in raw.items():
        if not isinstance(cfg, dict):
            raise ProviderConfigError(f'provider "{name}": expected an object')
        kind = cfg.get("type")
        if kind not in ("gateway", "anthropic", "openai"):
            raise ProviderConfigError(f'provider "{name}": unknown type {kind!r}')
        key_env = cfg.get("apiKeyEnv")
        key = _env(settings, key_env) if isinstance(key_env, str) else ""
        allow_insecure = cfg.get("allowInsecureBaseUrl") is True
        if kind == "gateway":
            if key:
                out[name] = Provider(name, base_url=GATEWAY_BASE_URL, auth_token=key)
            continue
        url_env = cfg.get("baseURLEnv")
        url = cfg.get("baseURL") if isinstance(cfg.get("baseURL"), str) else ""
        if not url and isinstance(url_env, str):
            url = _env(settings, url_env)
        if not url:
            continue
        if kind == "anthropic":
            if not key:
                continue
            _check_url(name, url, allow_insecure=allow_insecure)
            out[name] = Provider(name, base_url=_messages_base(url), api_key=key)
        else:  # "openai"
            # A key is required unless the provider is a local one that
            # takes none (Ollama: `allowInsecureBaseUrl`, as on Next).
            if not key and not allow_insecure:
                continue
            _check_url(name, url, allow_insecure=allow_insecure)
            out[name] = Provider(name, base_url=_messages_base(url), auth_token=key or name)
    return out


def route_model(entry: Mapping[str, Any], providers: Mapping[str, Provider]) -> ModelTarget:
    """`entry`'s target: Anthropic directly for an `anthropic/*` model when
    configured (Q115), else its first route with a configured provider. With
    none configured, the route it would take (direct for `anthropic/*`, else
    its first) with no provider."""
    model_id = str(entry["id"])
    direct: ModelTarget | None = None
    if model_id.startswith(ANTHROPIC_PREFIX):
        api_id = entry.get("anthropicModelId") or model_id[len(ANTHROPIC_PREFIX) :]
        direct = ModelTarget(model_id, str(api_id), None)
        if ANTHROPIC_DIRECT in providers:
            return ModelTarget(model_id, str(api_id), ANTHROPIC_DIRECT)
    routes = [r for r in entry.get("routes") or [] if isinstance(r, dict)]
    for route in routes:
        via = route.get("via")
        if isinstance(via, str) and via in providers:
            return _target(model_id, route, via)
    if direct is not None:
        return direct
    if routes and isinstance(routes[0].get("via"), str):
        return _target(model_id, routes[0], None)
    return ModelTarget(model_id, model_id, None)


def _target(model_id: str, route: Mapping[str, Any], provider: str | None) -> ModelTarget:
    upstream = route.get("upstreamId")
    fallbacks = route.get("fallbacks")
    return ModelTarget(
        model_id,
        upstream if isinstance(upstream, str) and upstream else model_id,
        provider,
        tuple(f for f in fallbacks if isinstance(f, str)) if isinstance(fallbacks, list) else (),
    )


def load_providers_json(models_path: Path) -> dict[str, Any]:
    """`providers.json` beside the catalog; absent → no providers but
    Anthropic's own (a deploy that ships only `models.json`)."""
    path = models_path.parent / "providers.json"
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ProviderConfigError(f"cannot read {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ProviderConfigError(f"{path}: expected an object of providers")
    return raw


# --- Clients ---------------------------------------------------------------

_clients: dict[Provider, Any] = {}


def client_for(provider: Provider | None) -> Any:
    """The provider's Anthropic SDK client (one per provider config), or None."""
    if provider is None:
        return None
    client = _clients.get(provider)
    if client is None:
        client = make_anthropic_client(
            base_url=provider.base_url, api_key=provider.api_key, auth_token=provider.auth_token
        )
        _clients[provider] = client
    return client


class _WithFallbacks:
    """A client whose every `messages.create` / `messages.stream` carries the
    route's backup models as OpenRouter's `models` list (Q118), as Next's
    OpenRouter fetch wrapper adds `body.models`."""

    def __init__(self, client: Any, fallbacks: tuple[str, ...]) -> None:
        self._client = client
        self.messages = _FallbackMessages(client.messages, list(fallbacks))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


class _FallbackMessages:
    def __init__(self, messages: Any, fallbacks: list[str]) -> None:
        self._messages = messages
        self._fallbacks = fallbacks

    def _with(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        return {
            **kwargs,
            "extra_body": {**(kwargs.get("extra_body") or {}), "models": self._fallbacks},
        }

    def create(self, **kwargs: Any) -> Any:
        return self._messages.create(**self._with(kwargs))

    def stream(self, **kwargs: Any) -> Any:
        return self._messages.stream(**self._with(kwargs))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._messages, name)


def client_for_route(provider: Provider | None, target: ModelTarget) -> Any:
    """`client_for(provider)`, carrying `target`'s backup models when it has any."""
    client = client_for(provider)
    if client is None or not target.fallbacks:
        return client
    return _WithFallbacks(client, target.fallbacks)


def reset_clients() -> None:
    """Forget the cached clients (tests)."""
    _clients.clear()


__all__ = [
    "ANTHROPIC_DIRECT",
    "GATEWAY_BASE_URL",
    "ModelTarget",
    "Provider",
    "ProviderConfigError",
    "client_for",
    "client_for_route",
    "configured_providers",
    "load_providers_json",
    "reset_clients",
    "route_model",
]
