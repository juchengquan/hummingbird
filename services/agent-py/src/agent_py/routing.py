"""Smart model routing — the heuristic classifier behind the `auto` model.

A port of `lib/server/routing/router.ts` (docs/PLAN-model-routing.md):
each turn goes to the cheapest *capable* model of the catalog's routing
pair (`model_allowlist.RoutingPair`) — trivial turns to the weak model,
hard turns to the strong one. Pure rules, no model call: same inputs,
same output, and the same thresholds / patterns as the TS router, so a
turn routes alike on Next and on runs.

The native harness's model resolver (`runs/harness_hooks.resolve_model`)
calls it for `forwardedProps.model == "auto"` and reports the choice as
a `routed_model` part.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from .model_allowlist import RoutingPair

__all__ = [
    "CODE_RE",
    "COMPLEXITY_RE",
    "HARD_LEN",
    "HARD_MESSAGE_COUNT",
    "RouteDecision",
    "RouteSignals",
    "route_model",
]

#: Prompts longer than this (chars) read as substantial asks.
HARD_LEN = 600
#: Conversations longer than this lean strong (more context to track).
HARD_MESSAGE_COUNT = 12
#: Markers of a non-trivial, reasoning-heavy ask. Word-boundaried,
#: case-insensitive — the TS `COMPLEXITY_RE`, verbatim. `re.ASCII` keeps
#: `\b` on JS's ASCII word characters (Python's are Unicode).
COMPLEXITY_RE = re.compile(
    r"\b(design|architect(?:ure)?|debug|refactor|optimi[sz]e|prove|deriv(?:e|ation)|analy[sz]e"
    r"|trade-?offs?|step[- ]by[- ]step|plan|implement|algorithm|complexity|reaso[n]"
    r"|strateg(?:y|ise|ize))\b",
    re.IGNORECASE | re.ASCII,
)
#: A fenced code block (or a strong hint of code) — the TS `CODE_RE`
#: (`m` flag: `$` at every line end).
CODE_RE = re.compile(r"```|\bfunction\b|\bclass\b|=>|;\s*$", re.MULTILINE | re.ASCII)


@dataclass(frozen=True)
class RouteSignals:
    text: str
    """The latest user message text."""
    has_attachments: bool
    """Any attachments on the turn — documents usually mean a harder ask."""
    message_count: int
    """Conversation length — long threads carry more context to track."""


@dataclass(frozen=True)
class RouteDecision:
    model_id: str
    tier: Literal["strong", "weak"]
    reason: str
    """Short machine reason for the choice — for debug logs."""


def route_model(signals: RouteSignals, pair: RoutingPair) -> RouteDecision:
    """Classify a turn and pick the model (TS `routeModel`)."""
    text = signals.text or ""

    def strong(reason: str) -> RouteDecision:
        return RouteDecision(model_id=pair.strong, tier="strong", reason=reason)

    if signals.has_attachments:
        return strong("attachments")
    if signals.message_count > HARD_MESSAGE_COUNT:
        return strong("long-thread")
    # JS `.length` counts UTF-16 code units; Python counts code points.
    if len(text.encode("utf-16-le")) // 2 > HARD_LEN:
        return strong("long-prompt")
    if CODE_RE.search(text):
        return strong("code")
    if COMPLEXITY_RE.search(text):
        return strong("complexity-keyword")
    return RouteDecision(model_id=pair.weak, tier="weak", reason="simple")
