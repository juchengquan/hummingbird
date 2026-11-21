"""`renderUI` validates `{kind, props}` against the frontend's schema.

`agent_py.ui_parts` checks a part against `ui_part_schema.json`
(generated from `UiPartSchema`, `lib/shared/generative-ui/schemas.ts`)
plus the one hand-mirrored rule (date-picker `min <= max`).
`fixtures/ui_part_parity.json` holds the TS schema's verdict on a case
corpus (`bun run codegen:agent-py-parity`); the port must agree on every
case. Then: an invalid call never pauses the run — the model gets the
error as its tool result (as from Next's `renderUI`) — and a valid one
still raises the `ui-part` interrupt.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_py.chat_loop import LoopInterrupted, LoopSucceeded
from agent_py.events import StepErrorEvent, ToolOutputEvent
from agent_py.input_policy import (
    ALWAYS_GATED_TOOL_NAMES,
    ASK_USER_TOOL_NAME,
    RENDER_UI_TOOL_NAME,
    pauses_for_input,
)
from agent_py.tools import ToolError, default_tool_registry
from agent_py.ui_parts import render_ui_args_error, ui_kinds

from .test_chat_events import _run, _text

_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "ui_part_parity.json").read_text(encoding="utf-8")
)
_REPO = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("case", _FIXTURE["cases"], ids=[c["name"] for c in _FIXTURE["cases"]])
def test_validity_matches_ts(case: dict[str, Any]) -> None:
    error = render_ui_args_error(case["part"])
    assert (error is None) == case["valid"], error


def test_kinds_match_the_ts_registry() -> None:
    source = (_REPO / "lib/shared/generative-ui/schemas.ts").read_text(encoding="utf-8")
    block = source.split("export const UI_KIND_VALUES = [", 1)[1].split("]", 1)[0]
    assert ui_kinds() == tuple(json.loads(f"[{block.strip().rstrip(',')}]"))


def test_errors_name_the_kind_and_the_path() -> None:
    assert render_ui_args_error({"kind": "confirm", "props": {"title": "Sure?"}}) == (
        "Invalid renderUI props for kind \"confirm\": 'prompt' is a required property (at props)"
    )
    assert render_ui_args_error({"kind": "slider", "props": {}}) == (
        'Invalid renderUI kind "slider": expected one of '
        "info-table, choice, confirm, mini-form, date-picker."
    )
    assert render_ui_args_error(
        {"kind": "date-picker", "props": {"prompt": "?", "min": "2026-03-01", "max": "2026-01-01"}}
    ) == ('Invalid renderUI props for kind "date-picker": min must be <= max (at props)')


def test_only_a_renderable_render_ui_call_pauses() -> None:
    gated = ALWAYS_GATED_TOOL_NAMES
    ok = {"kind": "confirm", "props": {"prompt": "Sure?"}}
    assert pauses_for_input(RENDER_UI_TOOL_NAME, ok, gated)
    assert not pauses_for_input(RENDER_UI_TOOL_NAME, {"kind": "confirm", "props": {}}, gated)
    assert not pauses_for_input(RENDER_UI_TOOL_NAME, None, gated)
    # Other gated tools pause whatever their args; ungated ones never.
    assert pauses_for_input(ASK_USER_TOOL_NAME, {}, gated)
    assert not pauses_for_input("webFetch", {}, gated)
    assert pauses_for_input("webFetch", {}, frozenset({"webFetch"}))


async def test_render_ui_execute_returns_the_validation_error() -> None:
    descriptor = default_tool_registry()[RENDER_UI_TOOL_NAME]
    with pytest.raises(ToolError, match="'prompt' is a required property"):
        await descriptor.execute({"kind": "confirm", "props": {"title": "Sure?"}})
    with pytest.raises(ToolError, match="gating is misconfigured"):
        await descriptor.execute({"kind": "confirm", "props": {"prompt": "Sure?"}})


async def test_an_invalid_render_ui_call_is_a_tool_error_and_the_turn_goes_on() -> None:
    bad = {"id": "c-ui", "name": RENDER_UI_TOOL_NAME, "input": {"kind": "confirm", "props": {}}}
    events, result = await _run(
        [{"tools": [bad]}, {"events": [_text("fixed")]}],
        tools=[default_tool_registry()[RENDER_UI_TOOL_NAME]],
        gated=ALWAYS_GATED_TOOL_NAMES,
    )
    assert isinstance(result.outcome, LoopSucceeded)
    errors = [e for e in events if isinstance(e, StepErrorEvent)]
    assert len(errors) == 1 and "'prompt' is a required property" in errors[0].message
    (out,) = [e for e in events if isinstance(e, ToolOutputEvent)]
    assert out.is_error and out.tool_call_id == "c-ui"
    assert result.text == "fixed"
    # renderUI is trusted: a refused call doesn't taint the turn's memory.
    assert result.tainted_by is None


async def test_a_valid_render_ui_call_still_pauses() -> None:
    ok = {
        "id": "c-ui",
        "name": RENDER_UI_TOOL_NAME,
        "input": {"kind": "confirm", "props": {"prompt": "Sure?"}},
    }
    _, result = await _run(
        [{"tools": [ok]}],
        tools=[default_tool_registry()[RENDER_UI_TOOL_NAME]],
        gated=ALWAYS_GATED_TOOL_NAMES,
    )
    assert isinstance(result.outcome, LoopInterrupted)
    assert [p.tool_name for p in result.outcome.pending] == [RENDER_UI_TOOL_NAME]


async def test_task_executor_step_runs_an_invalid_render_ui_call_instead_of_suspending() -> None:
    """The background executor's step (`anthropic_provider`) gates the
    same way: an invalid `renderUI` is executed (a tool error for the
    model), a valid one suspends as before."""
    from agent_py.emitter import RunEmitter
    from agent_py.events import TaskEvent
    from agent_py.providers.anthropic_provider import AnthropicStepConfig, make_anthropic_step_fn
    from agent_py.runner import RunStepContext

    from .test_anthropic_provider import _FakeClient

    async def step_for(args: dict[str, Any]) -> tuple[Any, list[dict[str, Any]]]:
        client = _FakeClient(
            deltas=[],
            final_content_seq=[
                [{"type": "tool_use", "id": "tu_ui", "name": RENDER_UI_TOOL_NAME, "input": args}]
            ],
        )
        events: list[TaskEvent] = []

        async def sink(e: TaskEvent) -> None:
            events.append(e)

        emitter = RunEmitter(run_id="r", sink=sink)
        messages: list[dict[str, Any]] = [{"role": "user", "content": "go"}]
        step = make_anthropic_step_fn(
            AnthropicStepConfig(
                client=client,
                model="claude-sonnet-4-6",
                system=None,
                messages=messages,
                tools=[default_tool_registry()[RENDER_UI_TOOL_NAME]],
                gated_tool_names=set(ALWAYS_GATED_TOOL_NAMES),
            )
        )
        await emitter.start_step()
        return await step(RunStepContext(step=emitter.step, emitter=emitter)), messages

    outcome, messages = await step_for({"kind": "confirm", "props": {"title": "Sure?"}})
    assert outcome.pending_input is None and outcome.done is False
    [result] = messages[-1]["content"]
    assert result["type"] == "tool_result" and result["is_error"] is True
    assert "'prompt' is a required property" in json.dumps(result["content"])

    outcome, _ = await step_for({"kind": "confirm", "props": {"prompt": "Sure?"}})
    assert outcome.pending_input is not None and outcome.pending_input.tool == RENDER_UI_TOOL_NAME
