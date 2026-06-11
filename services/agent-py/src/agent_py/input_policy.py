"""HITL request-kind taxonomy — the policy that decides which "kind" of
human input a paused tool call represents.

Mirror of `lib/server/agent/input-policy.ts`. Kept in one place so the
runner stays generic and the suspend path + respond path classify the
same way. Binary tool approval is the default kind: any gated tool
call suspends as `requestKind: "approval"`. The dedicated `askUser`
tool raises `choice` / `input` based on whether its args carry
`options`; `renderUI` always raises `ui-part`.
"""

from __future__ import annotations

from typing import Any, Literal

# Stable name for the `askUser` no-execute tool. Always gated.
ASK_USER_TOOL_NAME = "askUser"
# Stable name for the `renderUI` task-mode no-execute tool. Always
# gated. Mirror of `RENDER_UI_TOOL_NAME` in the TS input-policy.
RENDER_UI_TOOL_NAME = "renderUI"

# The four kinds the projection reducer understands. The TS-side
# projection tolerates unknown kinds, but we stay in this set so the
# wire is symmetric across producers.
RequestKind = Literal["approval", "choice", "input", "ui-part"]

# Set of tool names that are ALWAYS gated regardless of the
# request's `requireApprovalFor` list. These are no-execute HITL
# tools — they suspend the run instead of executing — so the gate
# must apply on every run that registers them.
ALWAYS_GATED_TOOL_NAMES: frozenset[str] = frozenset(
    {ASK_USER_TOOL_NAME, RENDER_UI_TOOL_NAME}
)


def request_kind_for(tool_name: str, args: Any) -> RequestKind:
    """Classify a pending input by tool name + args.

    - `renderUI` → `"ui-part"` (the structured-UI HITL kind).
    - `askUser` with `options[]` → `"choice"`; without → `"input"`.
    - anything else → `"approval"` (the binary approval gate).
    """
    if tool_name == RENDER_UI_TOOL_NAME:
        return "ui-part"
    if tool_name != ASK_USER_TOOL_NAME:
        return "approval"
    if isinstance(args, dict):
        options = args.get("options")
        if isinstance(options, list) and len(options) > 0:
            return "choice"
    return "input"
