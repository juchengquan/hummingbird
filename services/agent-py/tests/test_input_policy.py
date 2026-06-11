"""Tests for `input_policy.request_kind_for` + `ALWAYS_GATED_TOOL_NAMES`.

Mirror of the in-Next TS-side classifier in
`lib/server/agent/input-policy.ts`. The classifier is the single source
of truth on which kind of HITL gate a paused tool call represents —
both the suspend path (on emit) and the respond path (on resume)
consult it, so this needs to agree with the TS contract byte for byte.
"""

from __future__ import annotations

from agent_py.input_policy import (
    ALWAYS_GATED_TOOL_NAMES,
    ASK_USER_TOOL_NAME,
    RENDER_UI_TOOL_NAME,
    request_kind_for,
)


def test_render_ui_always_classifies_as_ui_part() -> None:
    """`renderUI` raises `ui-part` regardless of args shape — same as
    the TS `requestKindFor`."""
    assert request_kind_for(RENDER_UI_TOOL_NAME, {"kind": "choice", "props": {}}) == "ui-part"
    assert request_kind_for(RENDER_UI_TOOL_NAME, None) == "ui-part"
    assert request_kind_for(RENDER_UI_TOOL_NAME, {"anything": "goes"}) == "ui-part"


def test_ask_user_with_options_classifies_as_choice() -> None:
    args = {"prompt": "?", "options": [{"id": "a", "label": "A"}]}
    assert request_kind_for(ASK_USER_TOOL_NAME, args) == "choice"


def test_ask_user_without_options_classifies_as_input() -> None:
    """No `options[]` (or empty list) → free-form input mode."""
    assert request_kind_for(ASK_USER_TOOL_NAME, {"prompt": "Name?"}) == "input"
    assert request_kind_for(ASK_USER_TOOL_NAME, {"prompt": "Name?", "options": []}) == "input"


def test_ask_user_with_malformed_options_falls_back_to_input() -> None:
    """A non-list `options` field shouldn't crash the classifier; it
    falls back to `input` like the TS side."""
    assert request_kind_for(ASK_USER_TOOL_NAME, {"options": "not a list"}) == "input"
    assert request_kind_for(ASK_USER_TOOL_NAME, None) == "input"


def test_any_other_tool_classifies_as_approval() -> None:
    """Any gated tool that isn't askUser/renderUI is the binary
    approval gate — matches the TS default."""
    assert request_kind_for("myMcp__write", {"target": "prod"}) == "approval"
    assert request_kind_for("webFetch", {"url": "https://x"}) == "approval"


def test_always_gated_tool_names_contains_both_no_execute_tools() -> None:
    """Sanity — the always-gated set must include both no-execute
    HITL tools so the executor's gating union covers them."""
    assert ASK_USER_TOOL_NAME in ALWAYS_GATED_TOOL_NAMES
    assert RENDER_UI_TOOL_NAME in ALWAYS_GATED_TOOL_NAMES
    assert len(ALWAYS_GATED_TOOL_NAMES) == 2
