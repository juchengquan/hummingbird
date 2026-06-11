"""The `askUser` HITL tool — the agent's primary mechanism for asking
the human to pick one of N options (`requestKind: "choice"`) or
supply a value (`requestKind: "input"`).

Mirror of `lib/server/agent/ask-user-tool.ts`. Registered like any
other tool, but the executor's `_gated_tools_from` includes it in
`ALWAYS_GATED_TOOL_NAMES` so the Anthropic provider suspends the
run when the model calls it instead of executing. The `execute`
callable here exists only as a defensive fallback — if gating ever
fails, the model gets a clear error instead of silent malfunction.
The runner pairs the user's answer back as the tool result on
continuation."""

from __future__ import annotations

from typing import Any

from ..input_policy import ASK_USER_TOOL_NAME
from .registry import ToolDescriptor, ToolError, ToolInvocationResult

ASK_USER_DESCRIPTION = (
    "Pause the task and ask the user. Provide `options` (with stable "
    "`id`s) for a multiple-choice question (set `multi: true` to allow "
    "more than one pick) — omit `options` for a free-form input. Use "
    "this when the right next step genuinely depends on a user "
    "decision; prefer doing the work yourself when possible."
)

# JSON Schema (Anthropic tool wire format). Matches the Zod-derived
# shape in the TS `makeAskUserTool` factory: short prompt + optional
# options + optional multi flag.
ASK_USER_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "prompt": {
            "type": "string",
            "minLength": 1,
            "description": "The question for the user (short, one or two sentences).",
        },
        "options": {
            "type": "array",
            "maxItems": 10,
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "minLength": 1},
                    "label": {"type": "string", "minLength": 1},
                },
                "required": ["id", "label"],
            },
            "description": "Multiple-choice options. Omit for free-form input.",
        },
        "multi": {
            "type": "boolean",
            "description": "Allow the user to pick more than one option.",
        },
    },
    "required": ["prompt"],
}


async def _ask_user_execute_fallback(_args: dict[str, Any]) -> ToolInvocationResult:
    """Defensive — `askUser` should never reach the executor's
    invoke path because the always-gated check suspends the run
    first. If this fires, gating is broken; raise a clear ToolError
    so the failure is visible in the event stream instead of
    silently emitting a placeholder result."""
    raise ToolError(
        "askUser was invoked instead of suspended — gating is misconfigured"
    )


def build_ask_user_tool() -> ToolDescriptor:
    """Build the `askUser` no-execute tool descriptor.

    The descriptor's `execute` raises — it should never be reached
    because the executor's gating set includes `askUser`. Registered
    unconditionally by `default_tool_registry`."""
    return ToolDescriptor(
        name=ASK_USER_TOOL_NAME,
        description=ASK_USER_DESCRIPTION,
        input_schema=ASK_USER_INPUT_SCHEMA,
        execute=_ask_user_execute_fallback,
    )
