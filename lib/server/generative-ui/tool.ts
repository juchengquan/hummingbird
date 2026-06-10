import "server-only"

/**
 * Generative UI parts — server-side `renderUI` tool.
 *
 * The model calls this tool when a structured choice / short input /
 * info-table is genuinely more useful than prose. The tool's
 * `execute` validates `{ kind, props }` against the shared
 * `UiPartSchema` (`lib/shared/generative-ui/schemas.ts`) and returns
 * the validated pair. The chat route's tool-result handler reads the
 * return value and emits a `data-ui` SSE part with the same shape.
 *
 * Always-on (not a `ServerSkill`). System tools that don't take an
 * API key, don't fan out to providers, and don't make sense as a
 * user-toggleable skill chip bypass the `SkillId` registry entirely —
 * the chat route adds this tool to its `tools` map unconditionally
 * and appends the `RENDER_UI_PROMPT_FRAGMENT` to its system prompt.
 *
 * v1 ships only the `info-table` kind (read-only). Interactive kinds
 * land in commit 2 of `PLAN-generative-ui-parts.md`. The model's
 * `promptFragment` is intentionally conservative ("only when a
 * structured choice or short input genuinely helps") to avoid the
 * over-reach failure mode noted in the plan's open questions.
 */

import { tool } from "ai"
import { z } from "zod"

import {
  UI_KIND_VALUES,
  UiPartSchema,
  type UiKind,
} from "@/shared/generative-ui/schemas"

/** System-prompt fragment describing the `renderUI` tool to the
 *  model. Kept terse so it doesn't dominate the prefix budget.
 *
 *  Available kinds (v2):
 *  - `info-table` — read-only key/value or columnar table.
 *  - `choice` — 2–8 labelled options, single or multi-select.
 *  - `confirm` — yes/no inline confirm dialog.
 *  - `mini-form` — 1–4 short labelled text/number/select fields.
 *
 *  Interactive kinds (`choice` / `confirm` / `mini-form`) resolve as a
 *  follow-up user turn after the user submits, so prefer them when the
 *  next step depends on a clean structured input. */
export const RENDER_UI_PROMPT_FRAGMENT =
  "You can call the `renderUI` tool to render a structured component " +
  "inline in your reply. Only do this when the structure genuinely helps " +
  "the user (a clear table of related facts, a forced choice between " +
  "discrete options, a short form to fill in) — do NOT wrap every answer " +
  "in a UI part. Available kinds: " +
  "`info-table` (read-only key/value or columnar table; cap 50 rows, " +
  "500 chars per cell); " +
  "`choice` (2–8 options the user picks one or more of; the user's pick " +
  "becomes the next user message); " +
  "`confirm` (yes/no with optional custom labels; the user's answer " +
  "becomes the next user message); " +
  "`mini-form` (1–4 short fields the user fills in; the submitted " +
  "values become the next user message, after they confirm). " +
  "For interactive kinds, your next assistant turn will see the user's " +
  "answer as a normal user message — write your reply assuming that " +
  "answer is the user's words."

/** Shape returned by `renderUI`'s `execute`. The chat route reads
 *  this and emits the matching SSE `data-ui` part. */
export interface RenderUIToolResult {
  /** Always present — the validated kind. */
  kind: UiKind
  /** Validated against the kind's schema. */
  props: unknown
  /** Only set when validation rejected the input. The chat route
   *  treats this as "don't emit a part; surface the failure as a
   *  normal tool-result error" rather than throwing in render. */
  error?: string
}

/**
 * Build the `renderUI` tool. The chat route calls this once per turn
 * and registers the result under the tool name `renderUI` in its
 * `tools` map.
 *
 * Validation lives in `execute` rather than in the AI SDK's tool
 * `inputSchema` because:
 *   1. The model needs `props` typed as `unknown` (per-kind shapes
 *      vary); the SDK can't generate a tighter schema from the
 *      discriminated union without losing the model-facing
 *      ergonomics.
 *   2. Reading errors from `execute` lets us return them as
 *      tool-result text so the model can see "you tried kind `foo`
 *      but only `info-table` is allowed" and self-correct on the
 *      next step.
 */
export function buildRenderUITool() {
  return tool({
    description:
      "Render a structured UI component (e.g. an info-table) inline " +
      "in the chat reply. Use sparingly — only when structure helps.",
    inputSchema: z.object({
      kind: z.enum(UI_KIND_VALUES),
      // `props` is intentionally typed as `unknown` at the SDK level;
      // the per-kind shape is validated inside `execute` against the
      // shared `UiPartSchema` discriminated union.
      props: z.unknown(),
    }),
    execute: async ({ kind, props }): Promise<RenderUIToolResult> => {
      const parsed = UiPartSchema.safeParse({ kind, props })
      if (!parsed.success) {
        // Surface a short, model-readable error so it can self-correct.
        // The chat route translates this into a tool_result text frame
        // (not a `data-ui` part) so nothing renders.
        const firstIssue = parsed.error.issues[0]
        return {
          kind,
          props,
          error: firstIssue
            ? `Invalid renderUI props for kind "${kind}": ${firstIssue.message} (at ${firstIssue.path.join(".")})`
            : `Invalid renderUI props for kind "${kind}".`,
        }
      }
      return { kind: parsed.data.kind, props: parsed.data.props }
    },
  })
}

/** Stable tool name surfaced to the model. */
export const RENDER_UI_TOOL_NAME = "renderUI"
