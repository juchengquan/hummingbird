"""The `renderUI` task-mode tool — the agent loop's HITL variant of
the chat-route `renderUI` tool.

Mirror of `lib/server/agent/render-ui-task-tool.ts`. Same model-facing
contract as the chat version (`{ kind, props }`), but registered as a
no-execute / always-gated tool so the runner suspends the run as
`requestKind: "ui-part"` when the model calls it. The client renders
the right component from the shared generative-UI registry; the user's
answer rides back through `respond` carrying `uiAnswer` + the
back-compat `value` / `selection` shim, and the executor injects the
formatted text as the tool result.

See `docs/PLAN-generative-ui-parts.md` (commit 3b).
"""

from __future__ import annotations

from typing import Any

from ..input_policy import RENDER_UI_TOOL_NAME
from ..ui_parts import render_ui_args_error, ui_kinds
from .registry import ToolDescriptor, ToolError, ToolInvocationResult

# The kinds the shared `UiPartSchema` allows — read from the schema
# generated from it (`ui_parts`), so they can't drift.
UI_KIND_VALUES: tuple[str, ...] = ui_kinds()


RENDER_UI_DESCRIPTION = (
    "Pause the task and render a structured UI component for the user "
    "to answer. Pick `kind` from: "
    f"{' / '.join(UI_KIND_VALUES)}. "
    "Use sparingly — only when a structured choice or short input "
    "genuinely beats prose. The user's answer is injected as this "
    "tool's result on continuation."
)


# Coarse JSON schema for the model (as Next's `renderUI` input schema:
# `kind` + an untyped `props`); the per-kind shapes are spelled out in
# the description. The real check is `ui_parts.render_ui_args_error`
# (the shared `UiPartSchema`): a call that fails it never pauses the
# run — the model gets the error back as the tool result instead.
RENDER_UI_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "kind": {
            "type": "string",
            "enum": list(UI_KIND_VALUES),
        },
        "props": {
            "type": "object",
            "description": (
                "The kind-specific props. `confirm`: {prompt, confirmLabel?, "
                "cancelLabel?}; `choice`: {prompt, options: [{id, label}] (2 to 8), "
                "multiSelect?}; `info-table`: {title?, columns?: [{id, label}] "
                "(1 to 6), rows: [{<key or column id>: string}] (at most 50)}; "
                "`mini-form`: {prompt?, fields: [{type: text|number|select|date, "
                "id, label, ...}] (1 to 4), submitLabel?}; `date-picker`: {prompt, "
                "mode?: single|range, min?, max?}. Dates are ISO YYYY-MM-DD."
            ),
        },
    },
    "required": ["kind", "props"],
}


async def _render_ui_execute_fallback(args: dict[str, Any]) -> ToolInvocationResult:
    """Reached only for a call the gate let through: `{kind, props}` the
    client can't render (`input_policy.pauses_for_input`). The model gets
    the validation error back to correct, as from Next's `renderUI`.

    A *valid* call reaching here means gating is broken; raise a clear
    ToolError so the failure is visible instead of silently emitting a
    placeholder result."""
    error = render_ui_args_error(args)
    if error is not None:
        raise ToolError(error)
    raise ToolError("renderUI was invoked instead of suspended — gating is misconfigured")


def build_render_ui_tool() -> ToolDescriptor:
    """Build the `renderUI` no-execute tool descriptor.

    The descriptor's `execute` raises — a valid call never reaches it
    (the gate suspends the run first); an invalid one gets its
    validation error back as the tool error. Registered
    unconditionally by `default_tool_registry`."""
    return ToolDescriptor(
        name=RENDER_UI_TOOL_NAME,
        description=RENDER_UI_DESCRIPTION,
        input_schema=RENDER_UI_INPUT_SCHEMA,
        execute=_render_ui_execute_fallback,
    )
