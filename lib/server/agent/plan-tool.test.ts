import { describe, expect, test } from "bun:test"

import type { TaskEvent } from "@/shared/agent/events"
import { RunEmitter } from "@/shared/agent/emitter"
import { projectRun } from "@/shared/agent/project"
import { makePlanTool } from "./plan-tool"

function harness() {
  const events: TaskEvent[] = []
  let tick = 0
  const emitter = new RunEmitter(
    { runId: "r1", now: () => new Date(++tick).toISOString() },
    (e) => events.push(e)
  )
  return { emitter, events }
}

describe("makePlanTool", () => {
  test("emits the full plan list as a plan event", async () => {
    const { emitter, events } = harness()
    const tool = makePlanTool(emitter)
    const items = [
      { id: "a", text: "Research", status: "in_progress" as const },
      { id: "b", text: "Write up", status: "pending" as const },
    ]
    // The AI-SDK tool wraps execute; invoke it directly with empty options.
    const out = await (
      tool as unknown as {
        execute: (input: { items: typeof items }, opts: unknown) => Promise<unknown>
      }
    ).execute({ items }, {})

    expect(out).toEqual({ ok: true, summary: "0/2 steps complete" })
    const planEvents = events.filter((e) => e.kind === "plan")
    expect(planEvents).toHaveLength(1)
    expect(projectRun(events).plan).toEqual(items)
  })
})
