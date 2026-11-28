import { describe, expect, test } from "bun:test"

import { taskNotificationKey, tasksPointerKey, TASKS_POINTER_KEY_PREFIX } from "./types"

describe("task pointers", () => {
  test("are kept per signed-in user (Q68)", () => {
    expect(tasksPointerKey("u1")).toBe("humm.tasks.u1")
    expect(tasksPointerKey("u1").startsWith(TASKS_POINTER_KEY_PREFIX)).toBe(true)
    expect(tasksPointerKey("u1")).not.toBe(tasksPointerKey("u2"))
  })

  test("a notification is keyed per task and event, and a question per question (Q74)", () => {
    expect(taskNotificationKey("r", "done")).toBe("r:done")
    expect(taskNotificationKey("r", "failed")).toBe("r:failed")
    const a = taskNotificationKey("r", "needs_answer", { runId: "c1", interruptId: "q" })
    const b = taskNotificationKey("r", "needs_answer", { runId: "c2", interruptId: "q" })
    expect(a).toBe("r:needs_answer:c1:q")
    expect(a).not.toBe(b)
  })
})
