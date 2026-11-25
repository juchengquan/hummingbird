"""The editor AI prompts match the TypeScript builders byte for byte
(wave 9, Q101), replaying `fixtures/editor_ai_parity.json` — written by
`components/editor/ai/editor-ai.parity.test.ts` from the real TS code over
real Plate documents. A failure after a TS prompt change: regenerate the
fixture (`EDITOR_AI_PARITY_WRITE=1 bun test …`) and port the change."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_py.editor_ai.js_text import dedent
from agent_py.editor_ai.markdown_joiner import MarkdownJoiner
from agent_py.editor_ai.prompts import (
    EditorMessage,
    choose_tool_prompt,
    comment_prompt,
    complete_prompt,
    edit_prompt,
    generate_prompt,
    table_prompt,
)

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "editor_ai_parity.json").read_text(encoding="utf-8")
)


def _messages(raw: list[dict[str, Any]]) -> list[EditorMessage]:
    return [
        EditorMessage(
            role=m["role"],
            texts=tuple(p.get("text", "") for p in m["parts"] if p["type"] == "text"),
        )
        for m in raw
    ]


@pytest.mark.parametrize("case", FIXTURE["documents"], ids=lambda c: c["name"])
def test_prompts_match_the_ts_builders(case: dict[str, Any]) -> None:
    messages = _messages(case["messages"])
    doc = case["document"]
    expected = case["expected"]
    assert (
        choose_tool_prompt(is_selecting=doc["isSelecting"], messages=messages) == expected["choose"]
    )
    assert (
        generate_prompt(context=doc["generateContext"], messages=messages) == expected["generate"]
    )
    if doc["edit"]:
        got = edit_prompt(
            kind=doc["edit"]["kind"], context=doc["edit"]["context"], messages=messages
        )
        assert got == expected["edit"]
    else:
        assert expected["edit"] is None
    assert comment_prompt(context=doc["commentContext"], messages=messages) == expected["comment"]
    if expected["table"] is not None:
        assert table_prompt(context=doc["edit"]["context"], messages=messages) == expected["table"]


@pytest.mark.parametrize("case", FIXTURE["complete"], ids=lambda c: c["blockText"][:12])
def test_the_completion_prompt_matches(case: dict[str, Any]) -> None:
    assert (
        complete_prompt(block_text=case["blockText"], prefix=case.get("prefix")) == case["expected"]
    )


@pytest.mark.parametrize("case", FIXTURE["joiner"], ids=lambda c: c["chunks"][0][:16])
def test_the_markdown_joiner_matches(case: dict[str, Any]) -> None:
    joiner = MarkdownJoiner()
    for chunk, out in zip(case["chunks"], case["outputs"], strict=True):
        assert joiner.process_text(chunk) == out["text"]
        assert joiner.delay_ms == out["delayInMs"]
    assert joiner.flush() == case["flush"]


def test_dedent_follows_the_npm_package() -> None:
    """The quirks the prompts rely on: interpolated lines count toward the
    indentation, and a literal backslash-n becomes a newline."""
    # The value's "  y" sets the indent to 2, so the template's own lines
    # keep 2 of their 4 spaces (the first is then trimmed).
    assert dedent(("\n    head\n    more\n    ", "\n  "), "x\n  y") == "head\n  more\n  x\ny"
    assert dedent(("\n  two \\\\n\\\\n.\n",)) == "two \\\n\\\n."
    assert dedent(("  a \\\n     b",)) == "a b"
