import { describe, expect, test } from "bun:test"
import type { ProjectTask } from "@/shared/types"
import { diffProjectTasks } from "./handlers"

function make(id: string, overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id,
    workspaceId: "ws-1",
    title: `Task ${id}`,
    status: "todo",
    position: 0,
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffProjectTasks", () => {
  test("no ops when identical", () => {
    expect(diffProjectTasks([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new task with defaults", () => {
    const ops = diffProjectTasks([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("project_tasks")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.workspace_id).toBe("ws-1")
      expect(ops[0].row.status).toBe("todo")
      expect(ops[0].row.position).toBe(0)
      expect(ops[0].row.task_id).toBeNull()
      expect(ops[0].row.artifact_id).toBeNull()
    }
  })

  test("status move (todo → in_progress) triggers upsert", () => {
    const ops = diffProjectTasks(
      [make("a")],
      [
        make("a", {
          status: "in_progress",
          updatedAt: new Date("2026-05-23T01:00:00Z"),
        }),
      ]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") expect(ops[0].row.status).toBe("in_progress")
  })

  test("position renumber triggers upsert", () => {
    const ops = diffProjectTasks(
      [make("a", { position: 0 })],
      [
        make("a", {
          position: 2,
          updatedAt: new Date("2026-05-23T01:00:00Z"),
        }),
      ]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") expect(ops[0].row.position).toBe(2)
  })

  test("linking a card to a run + artifact round-trips", () => {
    const ops = diffProjectTasks(
      [make("a")],
      [
        make("a", {
          taskId: "run-1",
          artifactId: "art-1",
          status: "done",
          updatedAt: new Date("2026-05-23T05:00:00Z"),
        }),
      ]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.task_id).toBe("run-1")
      expect(ops[0].row.artifact_id).toBe("art-1")
      expect(ops[0].row.status).toBe("done")
    }
  })

  test("hard delete when a card vanishes", () => {
    const ops = diffProjectTasks([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
  })
})
