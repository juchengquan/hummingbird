import { describe, expect, test } from "bun:test"

import type { TaskQuestion } from "@/client/runs/tasks/types"

import {
  answerRefusal,
  childPill,
  launchRefusalText,
  phaseLabel,
  stepLimitNoteFor,
  stripStatus,
} from "./phase"

const q = (answeredBy: TaskQuestion["answeredBy"]): TaskQuestion => ({
  runId: "r",
  rootRunId: "r",
  interrupt: { id: "i", reason: "input", raw: { id: "i", reason: "input" } } as TaskQuestion["interrupt"],
  answeredBy,
  answerPending: false,
})

const base = { step: null, maxSteps: null, childrenAsking: 0, questions: [] as TaskQuestion[] }

describe("the runs list's words for a task", () => {
  test("a running task names its step", () => {
    expect(phaseLabel({ ...base, phase: "running", step: 3, maxSteps: 25 })).toBe("Running · step 3 / 25")
    expect(phaseLabel({ ...base, phase: "running" })).toBe("Running")
  })

  test("a question says whose it is", () => {
    expect(phaseLabel({ ...base, phase: "needs_answer", questions: [q("resume")] })).toBe("Needs your answer")
    expect(phaseLabel({ ...base, phase: "needs_answer", childrenAsking: 1 })).toBe("A sub-agent needs your answer")
    expect(phaseLabel({ ...base, phase: "needs_answer", childrenAsking: 2 })).toBe("2 sub-agents need your answer")
    expect(phaseLabel({ ...base, phase: "answer_sent" })).toContain("Answer sent")
  })

  test("the shared icon follows the phase", () => {
    expect(stripStatus("needs_answer")).toBe("paused")
    expect(stripStatus("succeeded")).toBe("done")
    expect(stripStatus("launching")).toBe("queued")
  })

  test("Q81: only a succeeded task that stopped at its limit carries the note", () => {
    const done = { phase: "succeeded" as const, maxSteps: 25 }
    expect(stepLimitNoteFor({ ...done, result: { text: "x", stoppedAt: "max_steps" } })).toContain("25 steps")
    expect(stepLimitNoteFor({ ...done, result: { text: "x" } })).toBeNull()
    expect(stepLimitNoteFor({ phase: "failed", maxSteps: 25, result: null })).toBeNull()
  })

  test("a skipped sub-agent reads skipped (Q60), an asking one asking", () => {
    expect(childPill({ status: "cancelled", question: null })).toBe("skipped")
    expect(childPill({ status: "interrupted", question: null })).toBe("asking")
    expect(childPill({ status: "interrupted", question: { ...q("in_place"), answerPending: true } })).toBe("answer sent")
  })

  test("refusals are said plainly", () => {
    expect(launchRefusalText("limit_reached", "", 5)).toContain("5 tasks running")
    expect(launchRefusalText("auth_required", "", 5)).toBe("Sign in to run tasks.")
    expect(answerRefusal("run_already_resumed", "").stale).toBe(true)
    expect(answerRefusal("run_answer_applied", "").text).toContain("Run it again")
    expect(answerRefusal("limit_reached", "").stale).toBe(false)
  })
})


describe("a task's title", () => {
  test("is the goal's first non-empty line, trimmed", async () => {
    const { taskGoalLine } = await import("./phase")
    expect(taskGoalLine("  Write the notes\nwith details ")).toBe("Write the notes")
    expect(taskGoalLine("\n\n  Second  \nthird")).toBe("Second")
    expect(taskGoalLine("")).toBe("Task")
    expect(taskGoalLine(null)).toBe("Task")
  })
})

describe("the task gate (bug 20, C's `loading`)", () => {
  test("it follows availability", async () => {
    const { taskGate } = await import("./phase")
    expect(taskGate({ ok: true })).toBe("ready")
    expect(taskGate({ ok: false, reason: "loading" })).toBe("loading")
    expect(taskGate({ ok: false, reason: "signed_out" })).toBe("signed_out")
  })
})
