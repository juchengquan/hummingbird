import { describe, expect, test } from "bun:test"
import type { Resource } from "@/shared/types"
import { diffResources } from "./handlers"

function make(id: string, overrides: Partial<Resource> = {}): Resource {
  return {
    id,
    workspaceId: "ws-1",
    fileId: `file-${id}`,
    addedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffResources", () => {
  test("no ops when identical", () => {
    expect(diffResources([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new resource", () => {
    const ops = diffResources([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("resources")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.workspace_id).toBe("ws-1")
      expect(ops[0].row.file_id).toBe("file-a")
    }
  })

  test("hard delete when a resource vanishes (untick from workspace)", () => {
    const ops = diffResources([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
    if (ops[0].kind === "delete") {
      expect(ops[0].where).toEqual({ column: "id", value: "b" })
    }
  })
})
