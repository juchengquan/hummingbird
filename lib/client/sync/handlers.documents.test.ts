import { describe, expect, test } from "bun:test"
import type { Document } from "@/shared/types"
import { diffDocuments } from "./handlers"

function make(id: string, overrides: Partial<Document> = {}): Document {
  return {
    id,
    workspaceId: "ws-1",
    title: `Doc ${id}`,
    content: "",
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffDocuments", () => {
  test("no ops when identical", () => {
    expect(diffDocuments([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new document", () => {
    const ops = diffDocuments([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.workspace_id).toBe("ws-1")
      expect(ops[0].row.title).toBe("Doc a")
      expect(ops[0].row.content).toBe("")
    }
  })

  test("upsert when content changes (the common edit path)", () => {
    const a = [make("a", { content: "old" })]
    const b = [
      make("a", {
        content: "new",
        updatedAt: new Date("2026-05-23T01:00:00Z"),
      }),
    ]
    const ops = diffDocuments(a, b)
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") expect(ops[0].row.content).toBe("new")
  })

  test("hard delete when a doc vanishes", () => {
    const ops = diffDocuments([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
    if (ops[0].kind === "delete") {
      expect(ops[0].where).toEqual({ column: "id", value: "b" })
    }
  })

  test("position change triggers upsert", () => {
    const a = [make("a", { position: 0 })]
    const b = [
      make("a", { position: 2, updatedAt: new Date("2026-05-23T02:00:00Z") }),
    ]
    expect(diffDocuments(a, b)).toHaveLength(1)
  })
})
