"""Tests for the askUser + renderUI no-execute HITL tools and the
executor paths that suspend / resume on them.

Mirror of the in-Next TS-side commit 3a contract
(`PLAN-generative-ui-parts.md`). Covers:

  - Tool descriptors register unconditionally + their `execute`
    raises (defensive — gating should keep this from firing).
  - Suspend path emits the right `request_kind` and pulls
    `prompt` / `options` / `multi` (askUser) or `ui_kind` / `ui_props`
    (renderUI) from the tool's args.
  - Respond path classifies the same way and produces the right
    `tool_result` text (choice → "User selected: …", input → raw
    value, ui-part → formatted text from the back-compat shim).
  - Poller parses `uiAnswer` from the job payload.

All hermetic — store + jobs writes patched; step fn injected via the
`make_step_fn` seam.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import executor, store
from agent_py.events import ApprovalEvent, TaskEvent
from agent_py.input_policy import (
    ASK_USER_TOOL_NAME,
    RENDER_UI_TOOL_NAME,
)
from agent_py.runner import (
    PendingInputDescriptor,
    RunStepContext,
    RunStepFn,
    RunStepOutcome,
)
from agent_py.tools import ToolError, default_tool_registry

# --- Tool descriptors ------------------------------------------------------


def test_default_registry_includes_ask_user_and_render_ui() -> None:
    """Both no-execute HITL tools register unconditionally — no env
    gate. Mirrors the TS path where `makeAskUserTool` /
    `makeRenderUITaskTool` are always available to the runner."""
    registry = default_tool_registry()
    assert ASK_USER_TOOL_NAME in registry
    assert RENDER_UI_TOOL_NAME in registry
    assert registry[ASK_USER_TOOL_NAME].name == "askUser"
    assert registry[RENDER_UI_TOOL_NAME].name == "renderUI"


def test_ask_user_input_schema_has_prompt_and_options() -> None:
    """Sanity — the descriptor exposes the wire shape Anthropic needs
    (prompt is required, options/multi are optional)."""
    descriptor = default_tool_registry()[ASK_USER_TOOL_NAME]
    schema = descriptor.input_schema
    assert schema["type"] == "object"
    assert "prompt" in schema["properties"]
    assert "options" in schema["properties"]
    assert "multi" in schema["properties"]
    assert schema["required"] == ["prompt"]


def test_render_ui_input_schema_has_kind_enum_and_props() -> None:
    descriptor = default_tool_registry()[RENDER_UI_TOOL_NAME]
    schema = descriptor.input_schema
    assert schema["type"] == "object"
    kind_field = schema["properties"]["kind"]
    assert kind_field["type"] == "string"
    # Pinned allow-list — adding a kind needs a deliberate update in
    # both languages.
    assert set(kind_field["enum"]) == {"info-table", "choice", "confirm", "mini-form"}
    assert schema["required"] == ["kind", "props"]


@pytest.mark.asyncio
async def test_ask_user_execute_raises_tool_error() -> None:
    """The no-execute tool's `execute` should never be reached —
    gating suspends the run first. If something invokes it, raise a
    clear ToolError so the failure is visible in the event stream
    instead of silently emitting a placeholder result."""
    descriptor = default_tool_registry()[ASK_USER_TOOL_NAME]
    with pytest.raises(ToolError, match="gating is misconfigured"):
        await descriptor.execute({})


@pytest.mark.asyncio
async def test_render_ui_execute_raises_tool_error() -> None:
    descriptor = default_tool_registry()[RENDER_UI_TOOL_NAME]
    with pytest.raises(ToolError, match="gating is misconfigured"):
        await descriptor.execute({})


# --- `_gated_tools_from` union --------------------------------------------


def test_gated_tools_includes_always_gated_no_execute_tools() -> None:
    """The executor's gating union always includes askUser + renderUI
    regardless of the checkpoint's `requireApprovalFor`."""
    # Empty checkpoint — gating should still cover the no-execute tools.
    assert ASK_USER_TOOL_NAME in executor._gated_tools_from({})
    assert RENDER_UI_TOOL_NAME in executor._gated_tools_from({})

    # With an explicit allow-list, the union is preserved.
    gated = executor._gated_tools_from({"config": {"requireApprovalFor": ["myMcp__write"]}})
    assert "myMcp__write" in gated
    assert ASK_USER_TOOL_NAME in gated
    assert RENDER_UI_TOOL_NAME in gated


# --- Suspend path ----------------------------------------------------------


def _make_suspend_step(
    *,
    tool_call_id: str,
    tool: str,
    args: dict[str, Any],
) -> executor.MakeStepFn:
    """Build a step fn whose only behaviour is to append the assistant
    turn with the pending tool_use and return a PendingInputDescriptor.
    Mimics the Anthropic provider's suspend branch."""

    def make(_p: Any, _c: Any, messages: list[Any], _ctx: Any = None) -> RunStepFn:
        async def step(_ctx: RunStepContext) -> RunStepOutcome:
            messages.append(
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": tool_call_id,
                            "name": tool,
                            "input": args,
                        }
                    ],
                }
            )
            return RunStepOutcome(
                done=False,
                pending_input=PendingInputDescriptor(
                    tool_call_id=tool_call_id,
                    tool=tool,
                    args=args,
                ),
            )

        return step

    return make


async def _drive_suspend(
    tool: str,
    args: dict[str, Any],
) -> list[TaskEvent]:
    """Run `execute_start` against a step that suspends immediately on
    the named tool, return the collected event log."""
    pool = MagicMock()
    payload = executor.StartActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
    )
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    make_step = _make_suspend_step(tool_call_id="tu_1", tool=tool, args=args)

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value={
                    "messages": [{"role": "user", "content": "go"}],
                    "config": {"model": "claude-sonnet-4-6"},
                }
            ),
        ),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "save_checkpoint", new=AsyncMock()),
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        await executor.execute_start(pool, payload, make_step_fn=make_step)

    return collected


@pytest.mark.asyncio
async def test_suspend_on_ask_user_choice_emits_request_kind_choice_with_options() -> None:
    """askUser with `options[]` → suspend emits `request_kind=choice`
    + `prompt` + `options` + `multi` from the tool's args. Client
    renders the option buttons from the event payload."""
    collected = await _drive_suspend(
        tool=ASK_USER_TOOL_NAME,
        args={
            "prompt": "Which env?",
            "options": [
                {"id": "prod", "label": "Production"},
                {"id": "stage", "label": "Staging"},
            ],
            "multi": False,
        },
    )

    requests = [e for e in collected if isinstance(e, ApprovalEvent) and e.phase == "request"]
    assert len(requests) == 1
    req = requests[0]
    assert req.request_kind == "choice"
    assert req.tool == ASK_USER_TOOL_NAME
    assert req.prompt == "Which env?"
    assert req.options is not None and [o.id for o in req.options] == ["prod", "stage"]
    assert req.multi is False
    # `ui_kind` / `ui_props` are renderUI-only.
    assert req.ui_kind is None and req.ui_props is None


@pytest.mark.asyncio
async def test_suspend_on_ask_user_input_emits_request_kind_input_no_options() -> None:
    """askUser without `options[]` → suspend emits
    `request_kind=input` + `prompt`. No options field on the event."""
    collected = await _drive_suspend(
        tool=ASK_USER_TOOL_NAME,
        args={"prompt": "What's your name?"},
    )

    requests = [e for e in collected if isinstance(e, ApprovalEvent) and e.phase == "request"]
    assert len(requests) == 1
    req = requests[0]
    assert req.request_kind == "input"
    assert req.prompt == "What's your name?"
    assert req.options is None


@pytest.mark.asyncio
async def test_suspend_on_render_ui_emits_request_kind_ui_part_with_ui_fields() -> None:
    """renderUI → suspend emits `request_kind=ui-part` + `ui_kind` +
    `ui_props` mirroring the tool's args. The client renders the
    matching component from the registry."""
    collected = await _drive_suspend(
        tool=RENDER_UI_TOOL_NAME,
        args={
            "kind": "confirm",
            "props": {
                "prompt": "Ship to prod?",
                "confirmLabel": "Ship",
                "cancelLabel": "Hold",
            },
        },
    )

    requests = [e for e in collected if isinstance(e, ApprovalEvent) and e.phase == "request"]
    assert len(requests) == 1
    req = requests[0]
    assert req.request_kind == "ui-part"
    assert req.tool == RENDER_UI_TOOL_NAME
    assert req.ui_kind == "confirm"
    assert req.ui_props == {
        "prompt": "Ship to prod?",
        "confirmLabel": "Ship",
        "cancelLabel": "Hold",
    }


# --- Respond path ----------------------------------------------------------


def _checkpoint_with_pending(
    *, tool_call_id: str, tool: str, args: dict[str, Any]
) -> dict[str, Any]:
    """Shape mimicking what `execute_start` would have saved after a
    suspend — assistant turn with a pending tool_use block."""
    return {
        "messages": [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": tool_call_id,
                        "name": tool,
                        "input": args,
                    },
                ],
            },
        ],
        "step": 1,
        "seq": 8,
        "config": {"model": "claude-sonnet-4-6"},
    }


async def _drive_respond(
    *,
    checkpoint: dict[str, Any],
    payload: executor.RespondActionPayload,
) -> tuple[dict[str, Any], list[TaskEvent]]:
    """Run `execute_respond` against the checkpoint, return the
    final saved checkpoint + the event log."""
    pool = MagicMock()
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    def make(_p: Any, _c: Any, _messages: list[Any], _ctx: Any = None) -> RunStepFn:
        async def step(_ctx: RunStepContext) -> RunStepOutcome:
            return RunStepOutcome(done=True)

        return step

    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_checkpoint,
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        await executor.execute_respond(pool, payload, make_step_fn=make)

    saved = save_checkpoint.await_args_list[0].kwargs["checkpoint"]
    return saved, collected


@pytest.mark.asyncio
async def test_respond_to_ask_user_choice_injects_selection_as_tool_result() -> None:
    """askUser with `options[]` + `selection=["prod"]` → tool_result
    reads "User selected: prod" (matches the TS path's text format).
    Also emits `input_response` with the selection so the client
    clears its pending state."""
    checkpoint = _checkpoint_with_pending(
        tool_call_id="tu_1",
        tool=ASK_USER_TOOL_NAME,
        args={
            "prompt": "Which env?",
            "options": [{"id": "prod", "label": "Production"}],
        },
    )
    payload = executor.RespondActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        request_id="tu_1",
        selection=["prod"],
    )

    saved, collected = await _drive_respond(checkpoint=checkpoint, payload=payload)

    # Tool result text is the canonical "User selected: …" format.
    tool_result = [m for m in saved["messages"] if m.get("role") == "user"][-1]["content"][0]
    assert tool_result["type"] == "tool_result"
    assert tool_result["tool_use_id"] == "tu_1"
    assert tool_result["content"] == "User selected: prod"

    # input_response carries the selection back to the client.
    responses = [e for e in collected if isinstance(e, ApprovalEvent) and e.phase == "response"]
    assert len(responses) == 1
    assert responses[0].selection == ["prod"]


@pytest.mark.asyncio
async def test_respond_to_ask_user_input_injects_raw_value_as_tool_result() -> None:
    """askUser without `options[]` + `value="Alice"` → tool_result is
    the raw value, no decoration. Mirrors `_build_tool_result_text`'s
    input branch and the TS path."""
    checkpoint = _checkpoint_with_pending(
        tool_call_id="tu_1",
        tool=ASK_USER_TOOL_NAME,
        args={"prompt": "Name?"},
    )
    payload = executor.RespondActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        request_id="tu_1",
        value="Alice",
    )

    saved, collected = await _drive_respond(checkpoint=checkpoint, payload=payload)

    tool_result = [m for m in saved["messages"] if m.get("role") == "user"][-1]["content"][0]
    assert tool_result["content"] == "Alice"

    responses = [e for e in collected if isinstance(e, ApprovalEvent) and e.phase == "response"]
    assert responses[0].value == "Alice"


@pytest.mark.asyncio
async def test_respond_to_render_ui_uses_back_compat_value_as_tool_result() -> None:
    """renderUI confirm answer → the client's `respondBodyForUiAnswer`
    shim populates `value` with the formatted text ("Ship"). The
    runner reads `value` directly — it doesn't have to re-port
    `formatAnswerForChat`. The `uiAnswer` structured payload still
    travels back to the client via the response event."""
    checkpoint = _checkpoint_with_pending(
        tool_call_id="tu_1",
        tool=RENDER_UI_TOOL_NAME,
        args={
            "kind": "confirm",
            "props": {"prompt": "Ship?", "confirmLabel": "Ship"},
        },
    )
    payload = executor.RespondActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        request_id="tu_1",
        value="Ship",  # the shim's formatted text
        ui_answer={"kind": "confirm", "confirmed": True},
    )

    saved, collected = await _drive_respond(checkpoint=checkpoint, payload=payload)

    tool_result = [m for m in saved["messages"] if m.get("role") == "user"][-1]["content"][0]
    assert tool_result["content"] == "Ship"

    responses = [e for e in collected if isinstance(e, ApprovalEvent) and e.phase == "response"]
    assert len(responses) == 1
    # uiAnswer rides on the response event so the client can also
    # mark the part as resolved with the structured answer.
    assert responses[0].ui_answer == {"kind": "confirm", "confirmed": True}


@pytest.mark.asyncio
async def test_respond_to_render_ui_with_only_ui_answer_falls_back_to_placeholder() -> None:
    """A malformed respond payload that carries `uiAnswer` but no
    formatted `value` / `selection` → tool_result is the neutral
    "(User submitted no answer.)" marker. The model still sees a
    parseable result instead of crashing the run."""
    checkpoint = _checkpoint_with_pending(
        tool_call_id="tu_1",
        tool=RENDER_UI_TOOL_NAME,
        args={"kind": "info-table", "props": {"rows": []}},
    )
    payload = executor.RespondActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        request_id="tu_1",
        ui_answer={"kind": "info-table"},
    )

    saved, _ = await _drive_respond(checkpoint=checkpoint, payload=payload)

    tool_result = [m for m in saved["messages"] if m.get("role") == "user"][-1]["content"][0]
    assert "User submitted no answer" in tool_result["content"]


# --- Poller wire shape -----------------------------------------------------


def test_poller_parses_ui_answer_from_respond_job_payload() -> None:
    """The TS route's `RespondRequestSchema` carries `uiAnswer` as
    `z.unknown().optional()`. The poller must surface it onto the
    RespondActionPayload so the executor can forward it to the
    client via `input_response`."""
    from agent_py import poller
    from agent_py.jobs import ClaimedJob

    job = ClaimedJob(
        id="job-1",
        task_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        action="respond",
        payload={
            "requestId": "tu_1",
            "value": "Ship",
            "uiAnswer": {"kind": "confirm", "confirmed": True},
        },
        attempts=1,
        max_attempts=3,
    )

    parsed = poller._respond_payload_from_job(job)
    assert parsed is not None
    assert parsed.request_id == "tu_1"
    assert parsed.value == "Ship"
    assert parsed.ui_answer == {"kind": "confirm", "confirmed": True}


def test_poller_tolerates_missing_ui_answer() -> None:
    """Pre-`ui-part` clients don't send `uiAnswer`; the parser falls
    through cleanly with `ui_answer=None`."""
    from agent_py import poller
    from agent_py.jobs import ClaimedJob

    job = ClaimedJob(
        id="job-1",
        task_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        action="respond",
        payload={"requestId": "tu_1", "approved": True},
        attempts=1,
        max_attempts=3,
    )

    parsed = poller._respond_payload_from_job(job)
    assert parsed is not None
    assert parsed.ui_answer is None
