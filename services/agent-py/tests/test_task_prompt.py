"""Q46 — the research task prompt, ported from
`lib/server/agent/task-prompt.ts` (`buildTaskSystemPrompt`, research mode)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from agent_py.task_prompt import build_research_system_prompt

TS_SOURCE = Path(__file__).resolve().parents[3] / "lib" / "server" / "agent" / "task-prompt.ts"


def _ts_fragments() -> list[str]:
    """Every string literal of the TypeScript research prompt, in order."""
    text = TS_SOURCE.read_text()
    start = text.index("const RESEARCH_LOOP_BASE")
    end = text.index("function buildResearchLoopPrompt")
    return [
        bytes(m, "utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8")
        for m in re.findall(r'"((?:[^"\\]|\\.)*)"', text[start:end])
    ]


@pytest.mark.skipif(not TS_SOURCE.exists(), reason="needs the repo's lib/")
def test_with_the_plan_tool_the_text_is_next_byte_for_byte() -> None:
    files = build_research_system_prompt(None, files_enabled=True, plan_tool=True)
    web = build_research_system_prompt(None, files_enabled=False, plan_tool=True)
    frags = _ts_fragments()
    # RESEARCH_LOOP_BASE, then 2b (files first | web only), then the tail —
    # buildResearchLoopPrompt's concatenation.
    base_end = frags.index("   a. Update `setPlan` to mark the current item `in_progress`.\n") + 1
    files_end = next(i for i, f in enumerate(frags) if f.startswith("   b. Use `webSearch`"))
    tail_start = next(i for i, f in enumerate(frags) if f.startswith("   c. Use `webFetch`"))
    base = "".join(frags[:base_end])
    files_2b = "".join(frags[base_end:files_end])
    web_2b = "".join(frags[files_end:tail_start])
    tail = "".join(frags[tail_start:])
    assert files == base + files_2b + tail
    assert web == base + web_2b + tail


def test_without_the_plan_tool_no_set_plan() -> None:
    p = build_research_system_prompt(None, files_enabled=False)
    assert "setPlan" not in p
    assert p.startswith("You are a research agent inside the Hummingbird app.")
    for step in ("1. Plan.", "Research each sub-question", "3. Gap pass.", "4. Synthesize."):
        assert step in p
    assert p.endswith("no chat reply is needed.")


def test_workspace_prompt_is_trimmed_and_first() -> None:
    p = build_research_system_prompt("  Custom voice.  ", files_enabled=False)
    assert p.startswith("Custom voice.\n\nYou are a research agent")
    assert build_research_system_prompt("   ", files_enabled=False).startswith("You are")
