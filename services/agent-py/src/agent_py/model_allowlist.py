"""Owner-approved model allowlist.

One list governs every backend: the repo's `config/models.json`. Every
catalog id is a model this service accepts (wave 10, Q109); anything else
(a raw API id, a typo) is `400 unknown_model`, the code the Next.js routes
return. Each model has a target (`model_routes.py`): the configured
provider that serves it and the id that provider knows it by — Anthropic
directly for an `anthropic/*` model when `ANTHROPIC_API_KEY` is set (its
`anthropicModelId`), else its first catalog route with a configured
provider. A model whose provider has no key here is still a valid id; its
calls fail `unavailable`, as a missing Anthropic key did before.

The allowlist + the configured default model are loaded and validated
once, at app construction (`create_app`), so a missing catalog or a
default outside it fails boot instead of the first request.

The catalog's `routing` pair (`{strong, weak}`, the `auto` option's two
models — `lib/shared/models.ts` `ROUTING_CONFIG`) is kept as
`ModelAllowlist.routing` when both ids are in the catalog.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import model_routes
from .model_routes import ModelTarget, Provider
from .settings import DEFAULT_AGENT_MODEL, Settings, get_settings

ANTHROPIC_PREFIX = "anthropic/"
_CONFIG_RELATIVE = Path("config") / "models.json"


class ModelConfigError(RuntimeError):
    """The catalog is missing / malformed, or the default model isn't on
    the allowlist. Raised at boot."""


class UnknownModelError(ValueError):
    """A model id outside the allowlist. Routes map it to
    `400 {"code": "unknown_model", ...}`; the executor fails the run."""

    code = "unknown_model"

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        super().__init__(
            f'Unknown model "{model_id}". This backend serves only the '
            "models listed in config/models.json."
        )

    def to_detail(self) -> dict[str, str]:
        return {"code": self.code, "message": str(self)}


class TaskModelError(UnknownModelError):
    """A catalog model that can't run background tasks: it can't call tools
    (`supportsTools: false`, Q117). Same `400 unknown_model` as an unknown id,
    so the client switches the task's model."""

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        ValueError.__init__(self, f"\"{model_id}\" can't run tasks: it can't call tools.")


#: The smart-routing sentinel (`AUTO_MODEL_ID` in `lib/shared/models.ts`).
AUTO_MODEL_ID = "auto"


@dataclass(frozen=True)
class RoutingPair:
    """`config/models.json` `routing`: the catalog ids `auto` picks
    between (`routing.route_model`)."""

    strong: str
    weak: str


@dataclass(frozen=True)
class ModelAllowlist:
    targets: Mapping[str, ModelTarget]
    """Catalog id → where its calls go (every catalog model)."""

    default_model: str
    """Catalog id of the service default (`AGENT_DEFAULT_MODEL`)."""

    structured_output: frozenset[str] = frozenset()
    """Catalog ids flagged `supportsStructuredOutput` — the same flag
    `modelSupportsStructuredOutput` in `lib/shared/models.ts` reads. A
    forced tool call (structured output) only works on these: Minimax, for
    one, answers a forced `tool_choice` in plain text (wave-10 probe)."""

    reasoning_effort: frozenset[str] = frozenset()
    """Catalog ids flagged `supportsReasoningEffort` — the flag
    `modelSupportsReasoningEffort` in `lib/shared/models.ts` reads (the
    models that take a thinking budget)."""

    vision: frozenset[str] = frozenset()
    """Catalog ids flagged `supportsVision`."""

    no_tools: frozenset[str] = frozenset()
    """Catalog ids flagged `supportsTools: false`: chat only — no tools on
    runs, not offered for tasks (Q116 / Q117)."""

    routing: RoutingPair | None = None
    """The `auto` pair when both of its ids are in the catalog, else None
    (`auto` is then an unknown model on this service)."""

    providers: Mapping[str, Provider] = field(default_factory=dict)
    """The configured providers, by name (`model_routes.configured_providers`)."""

    labels: Mapping[str, str] = field(default_factory=dict)
    """Catalog id → its `label`."""

    def supports_reasoning_effort(self, model_id: str | None) -> bool:
        """Whether the catalog flags `model_id` (absent / empty → the
        default model) as taking a reasoning-effort tier."""
        return (model_id or self.default_model) in self.reasoning_effort

    def supports_structured_output(self, model_id: str | None) -> bool:
        """Whether the catalog flags `model_id` (absent / empty → the
        default model) as supporting native structured output."""
        return (model_id or self.default_model) in self.structured_output

    def supports_tools(self, model_id: str | None) -> bool:
        return (model_id or self.default_model) not in self.no_tools

    @property
    def api_ids(self) -> Mapping[str, str]:
        """Catalog id → the id its provider knows it by."""
        return {model_id: t.api_id for model_id, t in self.targets.items()}

    def target(self, model_id: str) -> ModelTarget:
        """The target of a catalog id; raises `UnknownModelError` otherwise."""
        target = self.targets.get(model_id)
        if target is None:
            raise UnknownModelError(model_id)
        return target

    def target_optional(self, model_id: str | None) -> ModelTarget:
        """Absent / empty → the default model's target; else `target`."""
        return self.target(model_id) if model_id else self.default_target

    def structured_target(self, model_id: str | None) -> ModelTarget:
        """The target for a forced tool call on behalf of `model_id`: the model
        itself when the catalog flags it `supportsStructuredOutput`, else the
        service default (Q116). Raises `UnknownModelError` for a non-catalog id."""
        target = self.target_optional(model_id)
        if target.catalog_id in self.structured_output:
            return target
        return self.default_target

    def resolve(self, model_id: str) -> str:
        """The provider's id for a catalog id; raises `UnknownModelError`
        otherwise."""
        return self.target(model_id).api_id

    def resolve_optional(self, model_id: str | None) -> str:
        """Absent / empty → the default model's API id; else `resolve`."""
        return self.target_optional(model_id).api_id

    @property
    def default_target(self) -> ModelTarget:
        return self.targets[self.default_model]

    @property
    def default_api_id(self) -> str:
        return self.default_target.api_id

    def available(self, model_id: str) -> bool:
        """Whether a configured provider serves `model_id` here."""
        target = self.targets.get(model_id)
        return target is not None and target.available

    def runs_tasks(self, model_id: str) -> bool:
        """Whether background tasks may run on `model_id` (Q117): served
        here and able to call tools."""
        return self.available(model_id) and model_id not in self.no_tools

    def auto_available(self) -> bool:
        """Whether `auto` can run here: both models of its pair are served."""
        pair = self.routing
        return pair is not None and self.available(pair.strong) and self.available(pair.weak)

    def client(self, target: ModelTarget) -> Any:
        """The Anthropic SDK client for `target`'s provider, or None."""
        provider = self.providers.get(target.provider) if target.provider else None
        return model_routes.client_for_route(provider, target)


def parse_allowlist(
    raw: Any,
    *,
    default_model: str,
    source: str = "models.json",
    providers: Mapping[str, Provider] | None = None,
) -> ModelAllowlist:
    """Build the allowlist from the parsed catalog JSON and the configured
    providers (None → none). Pure — tests feed it hand-built dicts."""
    models = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(models, list):
        raise ModelConfigError(f"{source}: expected an object with a `models` array")
    configured = dict(providers or {})
    targets: dict[str, ModelTarget] = {}
    labels: dict[str, str] = {}
    flags: dict[str, set[str]] = {
        "structured": set(),
        "reasoning": set(),
        "vision": set(),
        "no_tools": set(),
    }
    for entry in models:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id")
        if not isinstance(model_id, str) or not model_id:
            continue
        explicit = entry.get("anthropicModelId")
        if explicit is not None and (not isinstance(explicit, str) or not explicit):
            raise ModelConfigError(f'{source}: "{model_id}" has an invalid anthropicModelId')
        if model_id.startswith(ANTHROPIC_PREFIX) and not (
            explicit or model_id[len(ANTHROPIC_PREFIX) :]
        ):
            raise ModelConfigError(f'{source}: "{model_id}" maps to an empty API id')
        if model_id in targets:
            raise ModelConfigError(f'{source}: duplicate model id "{model_id}"')
        targets[model_id] = model_routes.route_model(entry, configured)
        if isinstance(entry.get("label"), str):
            labels[model_id] = entry["label"]
        if entry.get("supportsStructuredOutput") is True:
            flags["structured"].add(model_id)
        if entry.get("supportsReasoningEffort") is True:
            flags["reasoning"].add(model_id)
        if entry.get("supportsVision") is True:
            flags["vision"].add(model_id)
        if entry.get("supportsTools") is False:
            flags["no_tools"].add(model_id)
    if not targets:
        raise ModelConfigError(f"{source}: no models — nothing to serve")
    if default_model not in targets:
        raise ModelConfigError(
            f'AGENT_DEFAULT_MODEL "{default_model}" is not a model in {source} '
            f"(allowed: {', '.join(sorted(targets))})"
        )
    return ModelAllowlist(
        targets=targets,
        default_model=default_model,
        structured_output=frozenset(flags["structured"]),
        reasoning_effort=frozenset(flags["reasoning"]),
        vision=frozenset(flags["vision"]),
        no_tools=frozenset(flags["no_tools"]),
        routing=_routing_pair(raw.get("routing"), targets),
        providers=configured,
        labels=labels,
    )


def _routing_pair(raw: object, targets: Mapping[str, ModelTarget]) -> RoutingPair | None:
    """The catalog's `routing` pair when both ids are in the catalog."""
    if not isinstance(raw, dict):
        return None
    strong, weak = raw.get("strong"), raw.get("weak")
    if not isinstance(strong, str) or not isinstance(weak, str):
        return None
    if strong not in targets or weak not in targets:
        return None
    return RoutingPair(strong=strong, weak=weak)


def find_models_config(start: Path | None = None) -> Path | None:
    """Walk up from `start` (default: this package) to the first
    directory holding `config/models.json`."""
    here = (start or Path(__file__)).resolve()
    for directory in [here, *here.parents]:
        candidate = directory / _CONFIG_RELATIVE
        if candidate.is_file():
            return candidate
    return None


def load_allowlist(
    path: Path | None, *, default_model: str, settings: Settings | None = None
) -> ModelAllowlist:
    """Read + parse the catalog at `path` (None → `find_models_config`), with
    the providers `settings` configures from the `providers.json` beside it
    (None → no providers)."""
    resolved = path or find_models_config()
    if resolved is None:
        raise ModelConfigError(
            "config/models.json not found — set MODELS_CONFIG_PATH "
            "(the Docker image ships it at /app/config/models.json)"
        )
    try:
        raw = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ModelConfigError(f"cannot read {resolved}: {exc}") from exc
    providers: dict[str, Provider] = {}
    if settings is not None:
        try:
            providers = model_routes.configured_providers(
                model_routes.load_providers_json(resolved), settings
            )
        except model_routes.ProviderConfigError as exc:
            raise ModelConfigError(str(exc)) from exc
    return parse_allowlist(
        raw, default_model=default_model, source=str(resolved), providers=providers
    )


@lru_cache(maxsize=1)
def get_model_allowlist() -> ModelAllowlist:
    """Process-wide allowlist, built from settings on first use."""
    settings = get_settings()
    configured = settings.MODELS_CONFIG_PATH.strip()
    return load_allowlist(
        Path(configured) if configured else None,
        # Empty (`AGENT_DEFAULT_MODEL=` in `.env`) → the built-in default.
        default_model=settings.AGENT_DEFAULT_MODEL.strip() or DEFAULT_AGENT_MODEL,
        settings=settings,
    )


def resolve_api_model_id(model_id: str) -> str:
    """Allowed catalog id → Anthropic API id; else `UnknownModelError`."""
    return get_model_allowlist().resolve(model_id)


def resolve_optional_model(model_id: str | None) -> str:
    """Absent / empty → default model's API id; else `resolve_api_model_id`."""
    return get_model_allowlist().resolve_optional(model_id)


def default_api_model_id() -> str:
    return get_model_allowlist().default_api_id


def resolve_target(model_id: str) -> ModelTarget:
    """Allowed catalog id → its target; else `UnknownModelError`."""
    return get_model_allowlist().target(model_id)


def resolve_optional_target(model_id: str | None) -> ModelTarget:
    """Absent / empty → the default model's target; else `resolve_target`."""
    return get_model_allowlist().target_optional(model_id)


def client_for_target(target: ModelTarget | None = None) -> Any:
    """The Anthropic SDK client serving `target` (None → the default model),
    or None when no configured provider serves it."""
    allowlist = get_model_allowlist()
    return allowlist.client(target or allowlist.default_target)


__all__ = [
    "ANTHROPIC_PREFIX",
    "AUTO_MODEL_ID",
    "ModelAllowlist",
    "ModelConfigError",
    "RoutingPair",
    "TaskModelError",
    "UnknownModelError",
    "client_for_target",
    "default_api_model_id",
    "find_models_config",
    "get_model_allowlist",
    "load_allowlist",
    "parse_allowlist",
    "resolve_api_model_id",
    "resolve_optional_model",
    "resolve_optional_target",
    "resolve_target",
]
