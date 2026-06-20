from __future__ import annotations

import pytest

from agent_py.tools.registry import ToolError  # ADJUST if ToolError lives elsewhere
from agent_py.tools.spawn_subagent import (
    MAX_CHILDREN,
    SPAWN_SUBAGENT_TOOL_NAME,
    build_spawn_subagent_tool,
    parse_spawn_specs,
)


def test_descriptor_shape() -> None:
    tool = build_spawn_subagent_tool()
    assert tool.name == SPAWN_SUBAGENT_TOOL_NAME
    assert "tasks" in tool.input_schema["properties"]


@pytest.mark.asyncio
async def test_execute_raises() -> None:
    tool = build_spawn_subagent_tool()
    with pytest.raises(ToolError):
        await tool.execute({"tasks": []})


def test_parse_drops_malformed_and_clamps() -> None:
    raw = {
        "tasks": [
            {"personaSlug": "a", "subgoal": "g1"},
            {"personaSlug": "b"},
            {"subgoal": "g3"},
            "nonsense",
        ]
    }
    specs = parse_spawn_specs(raw)
    assert [(s.persona_slug, s.subgoal) for s in specs] == [("a", "g1")]


def test_parse_clamps_to_max() -> None:
    raw = {"tasks": [{"personaSlug": f"p{i}", "subgoal": f"g{i}"} for i in range(MAX_CHILDREN + 3)]}
    assert len(parse_spawn_specs(raw)) == MAX_CHILDREN
