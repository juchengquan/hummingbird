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
from .registry import ToolDescriptor, ToolError, ToolInvocationResult

# The four kinds the shared `UiPartSchema` allows. Keep in lockstep
# with `UI_KIND_VALUES` in `lib/shared/generative-ui/schemas.ts` —
# adding a kind there means adding it here too.
UI_KIND_VALUES: tuple[str, ...] = (
    "info-table",
    "choice",
    "confirm",
    "mini-form",
)


RENDER_UI_DESCRIPTION = (
    "Pause the task and render a structured UI component for the user "
    "to answer. Pick `kind` from: "
    f"{' / '.join(UI_KIND_VALUES)}. "
    "Use sparingly — only when a structured choice or short input "
    "genuinely beats prose. The user's answer is injected as this "
    "tool's result on continuation."
)


# Coarse JSON schema — the discriminated `props` shape is enforced by
# the client-side Zod (`UiPartSchema`) on render. Going stricter here
# would mean encoding the discriminator-by-kind variant in JSON
# Schema, which Anthropic accepts but adds maintenance friction for
# little gain (the model produces sensible shapes from the
# description; a bad shape produces a non-renderable part, not a
# silent failure).
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
                "The kind-specific props payload. Shape depends on `kind`. "
                "See the chat-route renderUI tool description for per-kind "
                "schemas."
            ),
        },
    },
    "required": ["kind", "props"],
}


async def _render_ui_execute_fallback(_args: dict[str, Any]) -> ToolInvocationResult:
    """Defensive — `renderUI` should never reach the executor's
    invoke path because the always-gated check suspends the run
    first. If this fires, gating is broken; raise a clear ToolError
    so the failure is visible instead of silently emitting a
    placeholder result."""
    raise ToolError("renderUI was invoked instead of suspended — gating is misconfigured")


def build_render_ui_tool() -> ToolDescriptor:
    """Build the `renderUI` no-execute tool descriptor.

    The descriptor's `execute` raises — it should never be reached
    because the executor's gating set includes `renderUI`. Registered
    unconditionally by `default_tool_registry`."""
    return ToolDescriptor(
        name=RENDER_UI_TOOL_NAME,
        description=RENDER_UI_DESCRIPTION,
        input_schema=RENDER_UI_INPUT_SCHEMA,
        execute=_render_ui_execute_fallback,
    )
