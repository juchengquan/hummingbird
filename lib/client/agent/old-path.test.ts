/**
 * The old `/api/tasks` path's end-of-task effects and pointer, for users
 * not on runs (Q61: a task stays on the path it started on). Survey bugs
 * 2 (report in the active workspace), 3 (notifications only for `done`,
 * one shared tag), 6 (another account's pointer replayed; a 401 retried
 * forever) and 21 (delivered into a deleted conversation); the result is
 * written under the task's derived ids, so the runs list delivering the
 * same task is a no-op (Q70).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { memoryStorage } from "@/client/runs/fixtures"
import { useStore } from "@/client/hooks/use-store"
import { EMPTY_RUN_VIEW, type TaskRunView } from "@/shared/agent/project"
import { resultIdsFor } from "@/shared/runs/ids"

import type { TaskPhase } from "@/client/runs/tasks/types"

import { clearActiveTask, loadActiveTask, saveActiveTask } from "./active-task"
import { pointerPlan, runsHandOff } from "./old-pointer"
import { settleTask } from "./settle-task"

const USER_A = "aaaaaaaa-1111-4222-8333-444455556666"
const USER_B = "bbbbbbbb-1111-4222-8333-444455556666"

const shown: Array<{ title: string; tag?: string }> = []
const g = globalThis as unknown as Record<string, unknown>

beforeEach(() => {
  g.localStorage = memoryStorage()
  g.document = { visibilityState: "hidden" }
  g.window = globalThis
  class FakeNotification {
    static permission = "granted"
    constructor(title: string, opts?: { tag?: string }) {
      shown.push({ title, tag: opts?.tag })
    }
  }
  g.Notification = FakeNotification
  shown.length = 0
})

afterEach(() => {
  delete g.localStorage
  delete g.document
  delete g.window
  delete g.Notification
})

function done(text: string): TaskRunView {
  return { ...EMPTY_RUN_VIEW, status: "done", text, resultText: text }
}

function pointer(runId: string) {
  return { runId, conversationId: "c", cursor: 0, status: "running" as const, updatedAt: new Date().toISOString() }
}

describe("old-path pointer (bug 6)", () => {
  test("a pointer is the signed-in user's: another account never loads it", () => {
    saveActiveTask(pointer("run-a"), USER_A)
    expect(loadActiveTask(USER_B)).toBeNull()
    expect(loadActiveTask(USER_A)?.runId).toBe("run-a")
    clearActiveTask("run-a", USER_A)
    expect(loadActiveTask(USER_A)).toBeNull()
  })

})

describe("old-path settle", () => {
  test("a research report goes to the conversation's workspace, not the active one (bug 2)", async () => {
    const s = useStore.getState()
    const wsA = s.createWorkspace("Research A")
    const conv = useStore.getState().createConversation(wsA.id)
    const wsB = useStore.getState().createWorkspace("Elsewhere")
    useStore.getState().setActiveWorkspace(wsB.id)
    const runId = "11111111-aaaa-4bbb-8ccc-000000000001"
    await settleTask(runId, done("# Report\n\nText."), { conversationId: conv.id, mode: "research", userId: USER_A })
    // The newest document is the report.
    expect(useStore.getState().documents[0]?.workspaceId).toBe(wsA.id)
  })

  test("the result is written under the task's derived ids, once (Q70)", async () => {
    const conv = useStore.getState().createConversation()
    const runId = "11111111-aaaa-4bbb-8ccc-000000000005"
    const ids = resultIdsFor(USER_A, runId)
    await settleTask(runId, done("# R\n\nT."), { conversationId: conv.id, mode: "research", userId: USER_A })
    const messages = () => useStore.getState().conversations.find((c) => c.id === conv.id)!.messages
    expect(messages().map((m) => m.id)).toEqual([ids.messageId])
    expect(useStore.getState().documents.some((d) => d.id === ids.documentId)).toBe(true)
    expect(useStore.getState().artifacts.some((a) => a.id === ids.artifactId)).toBe(true)
  })

  test("a deleted conversation gets no message, document or artifact (bug 21)", async () => {
    const runId = "11111111-aaaa-4bbb-8ccc-000000000002"
    const docs = useStore.getState().documents.length
    const arts = useStore.getState().artifacts.length
    await settleTask(runId, done("# Report\n\nText."), { conversationId: "gone-conv", mode: "research", userId: USER_A })
    expect(useStore.getState().documents.length).toBe(docs)
    expect(useStore.getState().artifacts.length).toBe(arts)
  })

  test("a failed task notifies too, and each run has its own tag (bug 3)", async () => {
    const conv = useStore.getState().createConversation()
    await settleTask(
      "11111111-aaaa-4bbb-8ccc-000000000003",
      { ...EMPTY_RUN_VIEW, status: "failed", fatalError: "Broke" },
      { conversationId: conv.id, mode: "default", userId: USER_A },
    )
    await settleTask("11111111-aaaa-4bbb-8ccc-000000000004", done("ok"), {
      conversationId: conv.id,
      mode: "default",
      userId: USER_A,
    })
    expect(shown.map((n) => n.title)).toEqual(["Task failed", "Task finished"])
    expect(new Set(shown.map((n) => n.tag)).size).toBe(2)
  })
})

describe("old-path launch guard (bug 1)", () => {
  test("a second launch waits while a task runs here or in another tab", async () => {
    const { oldPathLaunchBlocked } = await import("./task-run-context")
    expect(oldPathLaunchBlocked(true, null, "r1")).toContain("already running")
    // Another tab's task: the user's pointer names another run.
    expect(oldPathLaunchBlocked(false, { runId: "r2", status: "queued" }, "r1")).toContain("another tab")
    expect(oldPathLaunchBlocked(false, { runId: "r2", status: "queued" }, null)).toContain("another tab")
    // This tab's own (cancelled, not yet cleared) pointer, or an ended one.
    expect(oldPathLaunchBlocked(false, { runId: "r1", status: "queued" }, "r1")).toBeNull()
    expect(oldPathLaunchBlocked(false, { runId: "r2", status: "done" }, null)).toBeNull()
    expect(oldPathLaunchBlocked(false, null, null)).toBeNull()
  })
})

describe("a pointer to a task started the old way, on runs (Q126)", () => {
  const live = { runId: "r-old", status: "running" as const }
  const row = (phase: TaskPhase) => ({ rootRunId: "r-old", phase })

  test("on agent-py (runs) it is followed through the runs list, never the old route", () => {
    expect(pointerPlan(live, { ok: true })).toBe("runs")
    // The old path keeps it off runs (ts / python / ts-service until wave 13).
    expect(pointerPlan(live, { ok: false, reason: "not_runs" })).toBe("old_path")
    // The session isn't read yet: neither path, so no `/api/tasks` read
    // goes out before the backend is known.
    expect(pointerPlan(live, { ok: false, reason: "loading" })).toBe("wait")
    // Signed out, a background task can't be read on either path.
    expect(pointerPlan(live, { ok: false, reason: "signed_out" })).toBe("none")
    expect(pointerPlan(null, { ok: true })).toBe("none")
  })

  test("a pointer this browser already saw end is dropped, whatever the backend", () => {
    for (const status of ["done", "failed", "cancelled"] as const) {
      expect(pointerPlan({ runId: "r", status }, { ok: true })).toBe("clear")
      expect(pointerPlan({ runId: "r", status }, { ok: false, reason: "not_runs" })).toBe("clear")
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
