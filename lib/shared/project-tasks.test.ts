import { describe, expect, test } from "bun:test"
import type { ProjectTask, ProjectTaskStatus } from "@/shared/types"
import { columnTasks, moveProjectTask, nextPosition } from "./project-tasks"

const NOW = new Date(2026, 0, 2)

function task(
  id: string,
  status: ProjectTaskStatus,
  position: number
): ProjectTask {
  return {
    id,
    workspaceId: "w1",
    title: `task ${id}`,
    status,
    position,
    createdAt: new Date(2026, 0, 1),
    updatedAt: new Date(2026, 0, 1),
  }
}

describe("columnTasks", () => {
  test("filters by status and sorts by position", () => {
    const tasks = [
      task("a", "todo", 1),
      task("b", "todo", 0),
      task("c", "done", 0),
    ]
    expect(columnTasks(tasks, "todo").map((t) => t.id)).toEqual(["b", "a"])
  })
})

describe("nextPosition", () => {
  test("0 for an empty column, max+1 otherwise", () => {
    expect(nextPosition([], "todo")).toBe(0)
    expect(nextPosition([task("a", "todo", 0), task("b", "todo", 3)], "todo")).toBe(4)
  })
})

describe("moveProjectTask", () => {
  test("intra-column reorder renumbers contiguously", () => {
    const tasks = [
      task("a", "todo", 0),
      task("b", "todo", 1),
      task("c", "todo", 2),
    ]
    // Move c to the front.
    const out = moveProjectTask(tasks, "c", "todo", 0, NOW)
    expect(columnTasks(out, "todo").map((t) => t.id)).toEqual(["c", "a", "b"])
    expect(columnTasks(out, "todo").map((t) => t.position)).toEqual([0, 1, 2])
  })

  test("inter-column move updates status + renumbers both columns", () => {
    const tasks = [
      task("a", "todo", 0),
      task("b", "todo", 1),
      task("c", "todo", 2),
      task("x", "in_progress", 0),
    ]
    // Move b → in_progress at index 0.
    const out = moveProjectTask(tasks, "b", "in_progress", 0, NOW)
    expect(columnTasks(out, "in_progress").map((t) => t.id)).toEqual(["b", "x"])
    expect(columnTasks(out, "in_progress").map((t) => t.position)).toEqual([0, 1])
    // Source column closed the gap: a, c at 0,1.
    expect(columnTasks(out, "todo").map((t) => t.id)).toEqual(["a", "c"])
    expect(columnTasks(out, "todo").map((t) => t.position)).toEqual([0, 1])
    expect(out.find((t) => t.id === "b")!.status).toBe("in_progress")
  })

  test("toIndex past the end clamps to the tail", () => {
    const tasks = [task("a", "todo", 0), task("x", "done", 0)]
    const out = moveProjectTask(tasks, "a", "done", 99, NOW)
    expect(columnTasks(out, "done").map((t) => t.id)).toEqual(["x", "a"])
  })

  test("unknown id is a no-op (same reference)", () => {
    const tasks = [task("a", "todo", 0)]
    expect(moveProjectTask(tasks, "nope", "done", 0, NOW)).toBe(tasks)
  })

  test("no-op move returns the same reference", () => {
    const tasks = [task("a", "todo", 0), task("b", "todo", 1)]
    // Move a to where it already is.
    expect(moveProjectTask(tasks, "a", "todo", 0, NOW)).toBe(tasks)
  })

  test("stamps updatedAt only on cards that changed", () => {
    const tasks = [task("a", "todo", 0), task("b", "todo", 1)]
    const out = moveProjectTask(tasks, "b", "todo", 0, NOW)
    // Both swapped position → both restamped.
    expect(out.find((t) => t.id === "a")!.updatedAt).toEqual(NOW)
    expect(out.find((t) => t.id === "b")!.updatedAt).toEqual(NOW)
  })
})
