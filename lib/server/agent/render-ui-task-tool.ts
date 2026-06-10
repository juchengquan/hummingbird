import "server-only"

/**
 * The `renderUI` task-mode tool — the agent loop's HITL variant of
 * the chat-route `renderUI` tool (`lib/server/generative-ui/tool.ts`).
 *
 * Same model-facing contract as the chat version (`{ kind, props }`
 * validated against the shared `UiPartSchema`), but registered
 * **WITHOUT** an `execute` so the runner can't run it — same
 * machinery as `makeAskUserTool` and the approval-gated MCP tools.
 * The runner suspends the run as `requestKind: "ui-part"`; the
 * `/api/tasks/:id/respond` body carries the structured answer via
 * `respondBodyForUiAnswer`. On continuation, the runner injects the
 * `formatAnswerForChat` text as the tool's result so the model
 * sees a normal completion.
 *
 * Counterpart to `makeAskUserTool`; intended to be registered the
 * same way once the agent-py / agent-ts runner ports `askUser`.
 * Today the task workers don't register either tool — both are
 * dead code on the Next.js side, kept as the canonical TS
 * reference for the Python port.
 *
 * See `docs/PLAN-generative-ui-parts.md` (commit 3).
 */

import { tool } from "ai"

import {
  UI_KIND_VALUES,
  UiPartSchema,
} from "@/shared/generative-ui/schemas"

import { RENDER_UI_TOOL_NAME } from "./input-policy"

export { RENDER_UI_TOOL_NAME }

export function makeRenderUITaskTool() {
  return tool({
    description:
      "Pause the task and render a structured UI component for the " +
      "user to answer. Pick `kind` from: " +
      `${UI_KIND_VALUES.join(" / ")}. ` +
      "Use sparingly — only when a structured choice or short input " +
      "genuinely beats prose. The user's answer is injected as this " +
      "tool's result on continuation.",
    // Use the shared UiPartSchema directly so the SDK's argument
    // validation rejects malformed payloads at parse time — same
    // discriminated union the chat-route version validates against,
    // same allow-list, same caps.
    inputSchema: UiPartSchema,
    // No `execute` — runner suspends; respond endpoint injects the
    // user's answer back to the loop.
  })
}
