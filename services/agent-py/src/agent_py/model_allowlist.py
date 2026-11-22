"""Owner-approved model allowlist.

One list governs every backend: the repo's `config/models.json`. This
service calls Anthropic directly, so it accepts only the file's
`anthropic/*` entries and maps each catalog id
(`anthropic/claude-sonnet-4.6`) to the Anthropic API id it sends
upstream (`claude-sonnet-4-6`) — the entry's `anthropicModelId`, else the
id with its `anthropic/` prefix stripped. Anything else (a non-Anthropic
catalog id, a raw API id, a typo) is `400 unknown_model`, the code the
Next.js routes return. agent-ts applies the same rule via
`ANTHROPIC_SERVICE_MODELS` in `lib/shared/models.ts`.

The allowlist + the configured default model are loaded and validated
once, at app construction (`create_app`), so a missing catalog or a
default outside the list fails boot instead of the first request.

The catalog's `routing` pair (`{strong, weak}`, the `auto` option's two
models — `lib/shared/models.ts` `ROUTING_CONFIG`) is kept as
`ModelAllowlist.routing` when both ids are on the allowlist; otherwise
`auto` is unavailable here (`routing` None) — a non-Anthropic pair is
fine for the Next routes, so it does not fail boot.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .settings import DEFAULT_AGENT_MODEL, get_settings

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
            "anthropic/* models listed in config/models.json."
        )

    def to_detail(self) -> dict[str, str]:
        return {"code": self.code, "message": str(self)}


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
    api_ids: Mapping[str, str]
    """Catalog id → Anthropic API model id."""

    default_model: str
    """Catalog id of the service default (`AGENT_DEFAULT_MODEL`)."""

    structured_output: frozenset[str] = frozenset()
    """Catalog ids flagged `supportsStructuredOutput` — the same flag
    `modelSupportsStructuredOutput` in `lib/shared/models.ts` reads."""

    reasoning_effort: frozenset[str] = frozenset()
    """Catalog ids flagged `supportsReasoningEffort` — the flag
    `modelSupportsReasoningEffort` in `lib/shared/models.ts` reads (the
    models that take a thinking budget)."""

    routing: RoutingPair | None = None
    """The `auto` pair when both of its ids are allowed here, else None
    (`auto` is then an unknown model on this service)."""

    def supports_reasoning_effort(self, model_id: str | None) -> bool:
        """Whether the catalog flags `model_id` (absent / empty → the
        default model) as taking a reasoning-effort tier."""
        return (model_id or self.default_model) in self.reasoning_effort

    def supports_structured_output(self, model_id: str | None) -> bool:
        """Whether the catalog flags `model_id` (absent / empty → the
        default model) as supporting native structured output."""
        return (model_id or self.default_model) in self.structured_output

    def resolve(self, model_id: str) -> str:
        """Anthropic API id for an allowed catalog id; raises
        `UnknownModelError` otherwise."""
        api_id = self.api_ids.get(model_id)
        if api_id is None:
            raise UnknownModelError(model_id)
        return api_id

    def resolve_optional(self, model_id: str | None) -> str:
        """Absent / empty → the default model's API id; else `resolve`."""
        return self.resolve(model_id) if model_id else self.default_api_id

    @property
    def default_api_id(self) -> str:
        return self.api_ids[self.default_model]


def parse_allowlist(raw: Any, *, default_model: str, source: str = "models.json") -> ModelAllowlist:
    """Build the allowlist from the parsed catalog JSON. Pure — tests
    feed it hand-built dicts."""
    models = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(models, list):
        raise ModelConfigError(f"{source}: expected an object with a `models` array")
    api_ids: dict[str, str] = {}
    structured: set[str] = set()
    reasoning: set[str] = set()
    for entry in models:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id")
        if not isinstance(model_id, str) or not model_id.startswith(ANTHROPIC_PREFIX):
            continue
        explicit = entry.get("anthropicModelId")
        if explicit is not None and (not isinstance(explicit, str) or not explicit):
            raise ModelConfigError(f'{source}: "{model_id}" has an invalid anthropicModelId')
        api_id = explicit or model_id[len(ANTHROPIC_PREFIX) :]
        if not api_id:
            raise ModelConfigError(f'{source}: "{model_id}" maps to an empty API id')
        if model_id in api_ids:
            raise ModelConfigError(f'{source}: duplicate model id "{model_id}"')
        api_ids[model_id] = api_id
        if entry.get("supportsStructuredOutput") is True:
            structured.add(model_id)
        if entry.get("supportsReasoningEffort") is True:
            reasoning.add(model_id)
    if not api_ids:
        raise ModelConfigError(f"{source}: no {ANTHROPIC_PREFIX}* models — nothing to serve")
    if default_model not in api_ids:
        raise ModelConfigError(
            f'AGENT_DEFAULT_MODEL "{default_model}" is not an {ANTHROPIC_PREFIX}* '
            f"model in {source} (allowed: {', '.join(sorted(api_ids))})"
        )
    return ModelAllowlist(
        api_ids=api_ids,
        default_model=default_model,
        structured_output=frozenset(structured),
        reasoning_effort=frozenset(reasoning),
        routing=_routing_pair(raw.get("routing"), api_ids),
    )


def _routing_pair(raw: object, api_ids: Mapping[str, str]) -> RoutingPair | None:
    """The catalog's `routing` pair when both ids are on the allowlist."""
    if not isinstance(raw, dict):
        return None
    strong, weak = raw.get("strong"), raw.get("weak")
    if not isinstance(strong, str) or not isinstance(weak, str):
        return None
    if strong not in api_ids or weak not in api_ids:
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


def load_allowlist(path: Path | None, *, default_model: str) -> ModelAllowlist:
    """Read + parse the catalog at `path` (None → `find_models_config`)."""
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
    return parse_allowlist(raw, default_model=default_model, source=str(resolved))


@lru_cache(maxsize=1)
def get_model_allowlist() -> ModelAllowlist:
    """Process-wide allowlist, built from settings on first use."""
    settings = get_settings()
    configured = settings.MODELS_CONFIG_PATH.strip()
    return load_allowlist(
        Path(configured) if configured else None,
        # Empty (`AGENT_DEFAULT_MODEL=` in `.env`) → the built-in default.
        default_model=settings.AGENT_DEFAULT_MODEL.strip() or DEFAULT_AGENT_MODEL,
    )


def resolve_api_model_id(model_id: str) -> str:
    """Allowed catalog id → Anthropic API id; else `UnknownModelError`."""
    return get_model_allowlist().resolve(model_id)


def resolve_optional_model(model_id: str | None) -> str:
    """Absent / empty → default model's API id; else `resolve_api_model_id`."""
    return get_model_allowlist().resolve_optional(model_id)


def default_api_model_id() -> str:
    return get_model_allowlist().default_api_id


__all__ = [
    "ANTHROPIC_PREFIX",
    "AUTO_MODEL_ID",
    "ModelAllowlist",
    "ModelConfigError",
    "RoutingPair",
    "UnknownModelError",
    "default_api_model_id",
    "find_models_config",
    "get_model_allowlist",
    "load_allowlist",
    "parse_allowlist",
    "resolve_api_model_id",
    "resolve_optional_model",
]
