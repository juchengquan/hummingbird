import "server-only"

/**
 * The `setPlan` tool — lets the agent declare and update its todo list
 * mid-run. Each call emits a `plan` event through the run emitter (full
 * list each time, per the event-model decision), which `reduceRun`
 * folds into `TaskRunView.plan` and the Tasks panel renders. The tool's
 * call/result are suppressed from the tool-pill strip (see the runner's
 * `silentTools`) so the plan list is the single surface for it.
 */

import { tool } from "ai"
import { z } from "zod"

import type { RunEmitter } from "@/shared/agent/emitter"
import type { PlanItem } from "@/shared/agent/events"

export const PLAN_TOOL_NAME = "setPlan"

const planItemInput = z.object({
  id: z
    .string()
    .min(1)
    .describe("Stable id for this step — keep it identical across updates."),
  text: z.string().min(1).describe("Short description of the step."),
  status: z.enum(["pending", "in_progress", "completed"]),
})

/**
 * Build the `setPlan` tool bound to a run's emitter. Closes over the
 * emitter so each invocation publishes the latest todo list.
 */
export function makePlanTool(emitter: RunEmitter) {
  return tool({
    description:
      "Declare or update your plan for this task as a todo list. Call it " +
      "once up front with your planned steps (all 'pending'), then call it " +
      "again whenever a step moves to 'in_progress' or 'completed'. Always " +
      "send the FULL list each time, reusing the same stable ids so the UI " +
      "can track progress.",
    inputSchema: z.object({
      items: z.array(planItemInput).min(1).max(20),
    }),
    execute: async ({ items }: { items: PlanItem[] }) => {
      emitter.plan(items)
      const done = items.filter((i) => i.status === "completed").length
      return { ok: true, summary: `${done}/${items.length} steps complete` }
    },
  })
}
