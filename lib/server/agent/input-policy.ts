import "server-only"

/**
 * The HITL request-kind taxonomy and the small bits of policy that
 * decide which "kind" of human input a paused tool call represents.
 *
 * Binary tool approval is the default kind: any gated tool call
 * suspends as `requestKind: "approval"`. The dedicated `askUser` tool
 * (added in Phase 5 of `PLAN-agent-hitl-approvals.md`) raises the
 * `choice` and `input` kinds based on whether its args carry options.
 *
 * Keeping this in one place so the runner stays generic and the route
 * + the respond route both classify the same way.
 */

/** Stable name for the `askUser` no-execute tool. */
export const ASK_USER_TOOL_NAME = "askUser"
/** Stable name for the `renderUI` task-mode no-execute tool — same
 *  name the chat-route version uses (see
 *  `lib/server/generative-ui/tool.ts`). In task mode the runner
 *  detects the unhandled tool call and suspends as a
 *  `requestKind: "ui-part"` HITL gate. */
export const RENDER_UI_TOOL_NAME = "renderUI"

export type RequestKind = "approval" | "choice" | "input" | "ui-part"

/** Classify a pending input by tool name + args. */
export function requestKindFor(
  toolName: string,
  args: unknown
): RequestKind {
  if (toolName === RENDER_UI_TOOL_NAME) return "ui-part"
  if (toolName !== ASK_USER_TOOL_NAME) return "approval"
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {}
  if (Array.isArray(a.options) && a.options.length > 0) return "choice"
  return "input"
}
