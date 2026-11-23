/**
 * The recorded background-run streams (wave 6) are whole and well formed,
 * so the tasks reducer (wave 6-C) can fold them: every scenario the
 * recorder writes is here, every role in its manifest has a stream, and
 * each stream is one run's complete SSE body.
 */
import { describe, expect, test } from "bun:test"

import { compareCursors } from "@/shared/runs/cursor"

import {
  backgroundScenarioNames,
  loadBackgroundFixture,
  loadBackgroundScenario,
} from "./fixtures"

const SCENARIOS = ["approval", "chain", "plan", "rewind", "spawn", "step-error"]

function names(scenario: string, role: string): string[] {
  return loadBackgroundFixture(scenario, role).items.map((i) => {
    const e = i.event as { type: string; name?: string }
    return e.type === "CUSTOM" && e.name ? e.name : e.type
  })
}

describe("recorded background runs", () => {
  test("every scenario is recorded", () => {
    expect(backgroundScenarioNames()).toEqual(SCENARIOS)
  })

  for (const scenario of SCENARIOS) {
    test(`${scenario}: each run's stream is complete, with increasing cursors`, () => {
      const manifest = loadBackgroundScenario(scenario)
      expect(manifest.scenario).toBe(scenario)
      for (const [role, run] of Object.entries(manifest.runs)) {
        const { items } = loadBackgroundFixture(scenario, role)
        const first = items[0].event as { type: string; runId?: string }
        expect(first.type).toBe("RUN_STARTED")
        expect(first.runId).toBe(run.runId)
        expect(["RUN_FINISHED", "RUN_ERROR"]).toContain(items.at(-1)!.event.type)
        const cursors = items.map((i) => i.cursor).filter((c): c is string => c !== null)
        for (let i = 1; i < cursors.length; i++) {
          expect(compareCursors(cursors[i - 1], cursors[i])).toBeLessThan(0)
        }
        if (run.parentRole) expect(manifest.runs[run.parentRole]).toBeDefined()
        if (run.previousRole) expect(manifest.runs[run.previousRole]).toBeDefined()
      }
    })
  }

  test("each scenario shows what it is named for", () => {
    expect(names("approval", "run")).toContain("hummingbird.interrupt_pending")
    expect(names("plan", "run").filter((n) => n === "ACTIVITY_SNAPSHOT").length).toBe(2)
    expect(names("step-error", "run")).toContain("hummingbird.step_error")
    expect(names("rewind", "run")).toContain("hummingbird.rewind")
    expect(names("spawn", "parent").filter((n) => n === "SUBAGENT_STARTED").length).toBe(2)
    expect(names("spawn", "child-asks-paused")).toContain("hummingbird.interrupt_pending")
    expect(names("spawn", "child-asks")).toContain("hummingbird.interrupt_resolved")
    const chain = loadBackgroundScenario("chain")
    expect(chain.runs.r1.previousRole).toBe("p0")
    expect(names("chain", "r1")).toContain("TOOL_CALL_RESULT")
  })
})
