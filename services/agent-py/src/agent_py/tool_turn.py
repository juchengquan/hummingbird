"""One assistant turn of tool calls — the pure half of "one result per
call" (wave 5c, B5 / B9).

A turn's calls are of three kinds:

  * the ones that just run (a malformed `spawnSubagent` among them: it
    answers with an error result);
  * the ones that wait for the user (`input_policy.pauses_for_input` — a
    gated `spawnSubagent` too), asked one after another;
  * the spawns, fanned out one after another once nothing is left to ask.

The model is called again only once every call has its one `tool_result`,
all in the user turn right after it. `providers.anthropic_provider`
classifies and runs the first kind; `executor._resolve_turn` does the
rest, the same on start, continue, respond and a runs resume.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from .input_policy import pauses_for_input
from .tools.spawn_subagent import SPAWN_SUBAGENT_TOOL_NAME, parse_spawn_specs


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    args: dict[str, Any]


def calls_of(blocks: Iterable[object]) -> list[ToolCall]:
    out: list[ToolCall] = []
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        args = block.get("input")
        out.append(
            ToolCall(
                id=str(block.get("id") or ""),
                name=str(block.get("name") or ""),
                args=dict(args) if isinstance(args, dict) else {},
            )
        )
    return out


def open_turn(messages: list[dict[str, Any]]) -> list[ToolCall]:
    """The calls of the history's final assistant turn: the history only
    ends in one while that turn is being answered."""
    if not messages or messages[-1].get("role") != "assistant":
        return []
    content = messages[-1].get("content")
    return calls_of(content) if isinstance(content, list) else []


def classify(
    calls: Iterable[ToolCall], gated: frozenset[str] | set[str]
) -> tuple[set[str], dict[str, dict[str, Any]]]:
    """`(the ids to ask, id → args of the spawns)`; the rest just run."""
    ask: set[str] = set()
    spawn: dict[str, dict[str, Any]] = {}
    for call in calls:
        is_spawn = call.name == SPAWN_SUBAGENT_TOOL_NAME
        if is_spawn and not parse_spawn_specs(call.args):
            continue  # nothing to approve: an error result
        if pauses_for_input(call.name, call.args, gated):
            ask.add(call.id)
        elif is_spawn:
            spawn[call.id] = call.args
    return ask, spawn


def ordered_results(
    calls: Iterable[ToolCall], results: Mapping[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    return [results[call.id] for call in calls]


def take_partial_results(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A checkpoint saved before wave 5c may end in a user turn that
    answers only some of the assistant turn before it (an answered
    question whose siblings had no result). Take that turn off
    `messages`, in place, and return its results so the turn is
    completed instead of being sent unpaired."""
    if len(messages) < 2 or messages[-1].get("role") != "user":
        return []
    blocks = messages[-1].get("content")
    if not isinstance(blocks, list) or not blocks:
        return []
    if not all(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks):
        return []
    asked = {call.id for call in open_turn(messages[:-1])}
    answered = {str(b.get("tool_use_id")) for b in blocks}
    if not answered < asked:
        return []
    messages.pop()
    return list(blocks)
