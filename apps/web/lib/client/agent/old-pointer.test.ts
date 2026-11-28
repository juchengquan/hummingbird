/**
 * The saved pointer to a task started the old way (`/api/tasks`, before
 * wave 13): the signed-in user's (bug 6), and followed through the runs
 * list (Q126) — nothing reads `/api/tasks` any more.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { memoryStorage } from "@/client/runs/fixtures"

import type { TaskPhase } from "@/client/runs/tasks/types"

import { serializeActiveTask } from "@/shared/agent/active-task"

import { clearActiveTask, loadActiveTask } from "./active-task"
import { pointerPlan, runsHandOff } from "./old-pointer"

const USER_A = "aaaaaaaa-1111-4222-8333-444455556666"
const USER_B = "bbbbbbbb-1111-4222-8333-444455556666"

const g = globalThis as unknown as Record<string, unknown>

beforeEach(() => {
  g.localStorage = memoryStorage()
})

afterEach(() => {
  delete g.localStorage
})

function pointer(runId: string) {
  return { runId, conversationId: "c", cursor: 0, status: "running" as const, updatedAt: new Date().toISOString() }
}

describe("the old pointer is the user's (bug 6)", () => {
  test("a pointer is the signed-in user's: another account never loads it", () => {
    localStorage.setItem(`humm.activeTask.${USER_A}`, serializeActiveTask(pointer("run-a")))
    expect(loadActiveTask(USER_B)).toBeNull()
    expect(loadActiveTask(USER_A)?.runId).toBe("run-a")
    clearActiveTask("run-a", USER_A)
    expect(loadActiveTask(USER_A)).toBeNull()
  })

})

describe("a pointer to a task started the old way (Q126)", () => {
  const live = { runId: "r-old", status: "running" as const }
  const row = (phase: TaskPhase) => ({ rootRunId: "r-old", phase })

  test("signed in it is followed through the runs list", () => {
    expect(pointerPlan(live, { ok: true })).toBe("runs")
    // The session isn't read yet.
    expect(pointerPlan(live, { ok: false, reason: "loading" })).toBe("wait")
    // Signed out, a background task can't be read.
    expect(pointerPlan(live, { ok: false, reason: "signed_out" })).toBe("none")
    expect(pointerPlan(null, { ok: true })).toBe("none")
  })

  test("a pointer this browser already saw end is dropped", () => {
    for (const status of ["done", "failed", "cancelled"] as const) {
      expect(pointerPlan({ runId: "r", status }, { ok: true })).toBe("clear")
      expect(pointerPlan({ runId: "r", status }, { ok: false, reason: "loading" })).toBe("clear")
    }
  })

  test("the runs list decides: a live task opens in the panel, an ended or unlisted one is dropped", () => {
    // Not read yet, or the read failed: wait for the list.
    expect(runsHandOff(live, { tasks: null, listError: null })).toBe("wait")
    expect(runsHandOff(live, { tasks: [], listError: { code: "network", message: "x" } })).toBe("wait")
    for (const phase of ["queued", "running", "needs_answer", "answer_sent"] as const) {
      expect(runsHandOff(live, { tasks: [row(phase)], listError: null })).toBe("focus")
    }
    // Finished while away (the pointer still says running): the runs list
    // delivers it under the task's derived ids, so the pointer just goes.
    for (const phase of ["succeeded", "failed", "cancelled"] as const) {
      expect(runsHandOff(live, { tasks: [row(phase)], listError: null })).toBe("clear")
    }
    // Another account's, or deleted.
    expect(runsHandOff(live, { tasks: [{ rootRunId: "other", phase: "running" }], listError: null })).toBe("clear")
  })
})
