import { describe, expect, test } from "bun:test"
import type { Workspace } from "@/shared/types"
import { diffWorkspaces } from "./handlers"

function make(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffWorkspaces", () => {
  test("no ops when prev and next are identical", () => {
    const a = [make("a"), make("b")]
    const b = [make("a"), make("b")]
    expect(diffWorkspaces(a, b)).toEqual([])
  })

  test("upsert for a brand-new workspace", () => {
    const ops = diffWorkspaces([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    expect(ops[0].target).toBe("workspaces")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.name).toBe("Workspace a")
      // Sane defaults for nullable columns.
      expect(ops[0].row.system_prompt).toBeNull()
      expect(ops[0].row.is_project).toBe(false)
    }
  })

  test("upsert when a leaf field changes", () => {
    const ops = diffWorkspaces(
      [make("a")],
      [make("a", { name: "Renamed", updatedAt: new Date("2026-05-23T01:00:00Z") })]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") expect(ops[0].row.name).toBe("Renamed")
  })

  test("hard delete when a workspace vanishes", () => {
    const ops = diffWorkspaces([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
    if (ops[0].kind === "delete") {
      expect(ops[0].where).toEqual({ column: "id", value: "b" })
    }
  })

  test("project-mode fields round-trip", () => {
    const ops = diffWorkspaces(
      [],
      [make("a", {
        isProject: true,
        goal: "Ship the docs",
        milestones: [{ title: "M1", dueDate: "2026-06-01" }],
      })]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.is_project).toBe(true)
      expect(ops[0].row.goal).toBe("Ship the docs")
      expect(ops[0].row.milestones).toEqual([
        { title: "M1", dueDate: "2026-06-01" },
      ])
    }
  })

  test("skill prefs change triggers upsert", () => {
    const a = [make("a", { skillPrefs: { webSearch: true } })]
    const b = [make("a", {
      skillPrefs: { webSearch: true, webFetch: false },
      updatedAt: new Date("2026-05-23T02:00:00Z"),
    })]
    const ops = diffWorkspaces(a, b)
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
  })

  test("canvas-state change rides on the updatedAt bump (workspaceEquals checks createdAt+updatedAt only for time)", () => {
    const a = [make("a")]
    const b = [
      make("a", {
        updatedAt: new Date("2026-05-23T05:00:00Z"),
        canvasState: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      }),
    ]
    const ops = diffWorkspaces(a, b)
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
  })
})
