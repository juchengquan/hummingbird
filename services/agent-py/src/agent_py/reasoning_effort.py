"""Reasoning effort → Anthropic extended-thinking parameters.

Port of `reasoningCallOptions` in `lib/shared/reasoning-effort.ts` (the
Next chat route's mapping), for the `anthropic` branch — the only
provider this service talks to:

| effort | `thinking` | `max_tokens` |
|---|---|---|
| `low` | `{"type": "enabled", "budget_tokens": 2048}` | 2048 + 8192 |
| `medium` | `{"type": "enabled", "budget_tokens": 8192}` | 8192 + 8192 |
| `high` | `{"type": "enabled", "budget_tokens": 16384}` | 16384 + 8192 |

Anthropic requires `max_tokens` above the thinking budget, hence the
answer margin on top, exactly as on the Next route. A model the catalog
does not flag `supportsReasoningEffort` (`config/models.json`) gets no
thinking parameters — the tier is ignored, as the client never offers it
there. Pure apart from reading the allow-list.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .model_allowlist import get_model_allowlist

__all__ = [
    "ANSWER_MARGIN",
    "REASONING_EFFORTS",
    "THINKING_BUDGET",
    "ReasoningEffort",
    "ThinkingParams",
    "parse_reasoning_effort",
    "thinking_params",
]

ReasoningEffort = Literal["low", "medium", "high"]
REASONING_EFFORTS: tuple[ReasoningEffort, ...] = ("low", "medium", "high")

#: Thinking-token budget per tier — `THINKING_BUDGET` in
#: `lib/shared/reasoning-effort.ts`.
THINKING_BUDGET: dict[ReasoningEffort, int] = {"low": 2048, "medium": 8192, "high": 16384}
#: Room for the answer on top of the budget — `ANSWER_MARGIN` there.
ANSWER_MARGIN = 8192


@dataclass(frozen=True)
class ThinkingParams:
    """What a model call adds for a reasoning tier."""

    thinking: dict[str, Any]
    max_tokens: int


def parse_reasoning_effort(value: object) -> ReasoningEffort | None:
    if value == "low" or value == "medium" or value == "high":
        return value
    return None


def thinking_params(model_id: str | None, effort: ReasoningEffort | None) -> ThinkingParams | None:
    """The thinking parameters for `effort` on catalog model `model_id`
    (None → the service default); None when no tier is asked for or the
    model takes none."""
    if effort is None or not get_model_allowlist().supports_reasoning_effort(model_id):
        return None
    budget = THINKING_BUDGET[effort]
    return ThinkingParams(
        thinking={"type": "enabled", "budget_tokens": budget},
        max_tokens=budget + ANSWER_MARGIN,
    )
