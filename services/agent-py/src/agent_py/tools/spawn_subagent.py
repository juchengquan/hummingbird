"""The `spawnSubagent` tool — a no-execute (gated-shape) tool. When the
model calls it, the step fn captures it as a SpawnDescriptor and the
executor fans out child tasks; it is never executed inline (its
`execute` raises, like `ask_user`)."""

from __future__ import annotations

import os
from typing import Any

from agent_py.runner import SpawnSpec
from agent_py.tools.registry import ToolDescriptor, ToolError, ToolInvocationResult

SPAWN_SUBAGENT_TOOL_NAME = "spawnSubagent"


def _max_children() -> int:
    raw = os.environ.get("MAX_SPAWN_CHILDREN")
    if raw:
        try:
            n = int(raw)
            if n > 0:
                return n
        except ValueError:
            pass
    return 5


MAX_CHILDREN = _max_children()

MAX_TASK_CHILDREN = 20
"""Sub-agent runs one task may start, over all its spawns and every run
of its chain (Q72): `store.commit_spawn` counts them
(`private.task_child_count`, 0047) under the user's task lock."""


def task_child_cap_error(started: int) -> str:
    """The error `tool_result` of a spawn past `MAX_TASK_CHILDREN`."""
    left = max(0, MAX_TASK_CHILDREN - started)
    more = (
        f"at most {left} more can be started — ask for fewer."
        if left
        else "no more can be started — continue without sub-agents."
    )
    return (
        f"No sub-agent was started: a task may start at most {MAX_TASK_CHILDREN} "
        f"sub-agents and this one has started {started}, so {more}"
    )


_DESCRIPTION = (
    "Decompose this goal into specialist subagents, each pinned to a "
    "subgoal. They run in parallel; you resume with their results. Use "
    "only when the goal genuinely splits into independent subtasks."
)

_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_CHILDREN,
            "items": {
                "type": "object",
                "properties": {
                    "personaSlug": {"type": "string"},
                    "subgoal": {"type": "string"},
                },
                "required": ["personaSlug", "subgoal"],
            },
        }
    },
    "required": ["tasks"],
}


SPAWN_ARGS_ERROR = (
    "spawnSubagent needs `tasks`: a non-empty list of {personaSlug, subgoal}, "
    "both non-empty strings. No subagent was started."
)


async def _spawn_execute_fallback(args: dict[str, Any]) -> ToolInvocationResult:
    if not parse_spawn_specs(args):
        # An empty or malformed spawn just runs, and tells the model.
        raise ToolError(SPAWN_ARGS_ERROR)
    raise ToolError("spawnSubagent must be handled by the executor (fan-out), not executed inline.")


def build_spawn_subagent_tool() -> ToolDescriptor:
    return ToolDescriptor(
        name=SPAWN_SUBAGENT_TOOL_NAME,
        description=_DESCRIPTION,
        input_schema=_INPUT_SCHEMA,
        execute=_spawn_execute_fallback,
    )


def parse_spawn_specs(args: Any) -> list[SpawnSpec]:
    """Pure: extract valid SpawnSpecs from a tool-call's args, dropping
    malformed entries and clamping to MAX_CHILDREN."""
    specs: list[SpawnSpec] = []
    tasks = args.get("tasks") if isinstance(args, dict) else None
    if not isinstance(tasks, list):
        return specs
    for item in tasks:
        if not isinstance(item, dict):
            continue
        slug = item.get("personaSlug")
        subgoal = item.get("subgoal")
        if isinstance(slug, str) and slug and isinstance(subgoal, str) and subgoal:
            specs.append(SpawnSpec(persona_slug=slug, subgoal=subgoal))
        if len(specs) >= MAX_CHILDREN:
            break
    return specs
