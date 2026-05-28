import "server-only"

/**
 * The `askUser` HITL tool — the agent's primary mechanism for asking
 * the human to **pick one of N options** (`requestKind: "choice"`) or
 * **supply a value** (`requestKind: "input"`). Registered WITHOUT an
 * `execute`, so the AI SDK can't run it and the runner suspends the
 * run for human input (same machinery as approval-gated MCP tools).
 *
 * The runner pairs the human's answer (selection / value) back as the
 * tool's result on continuation; the model reads it and adapts.
 */

import { tool } from "ai"
import { z } from "zod"

import { ASK_USER_TOOL_NAME } from "./input-policy"

export { ASK_USER_TOOL_NAME }

export function makeAskUserTool() {
  return tool({
    description:
      "Pause the task and ask the user. Provide `options` (with stable " +
      "`id`s) for a multiple-choice question (set `multi: true` to allow " +
      "more than one pick) — omit `options` for a free-form input. Use " +
      "this when the right next step genuinely depends on a user " +
      "decision; prefer doing the work yourself when possible.",
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .describe("The question for the user (short, one or two sentences)."),
      options: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
          })
        )
        .max(10)
        .optional()
        .describe("Multiple-choice options. Omit for free-form input."),
      multi: z
        .boolean()
        .optional()
        .describe("Allow the user to pick more than one option."),
    }),
    // No `execute` — this tool's "execution" is the human's answer,
    // injected by the respond endpoint on continuation.
  })
}
