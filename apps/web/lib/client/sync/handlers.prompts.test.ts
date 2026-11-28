import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/shared/types"
import { diffPrompts } from "./handlers"

function make(id: string, overrides: Partial<Prompt> = {}): Prompt {
  return {
    id,
    workspaceId: "ws-default",
    name: `Prompt ${id}`,
    slug: `prompt-${id}`,
    template: `Hello, {name}!`,
    variables: ["name"],
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffPrompts", () => {
  test("no ops when prev and next are identical", () => {
    const a = [make("a"), make("b")]
    const b = [make("a"), make("b")]
    expect(diffPrompts(a, b)).toEqual([])
  })

  test("emits an upsert for a brand-new prompt", () => {
    const ops = diffPrompts([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    expect(ops[0].target).toBe("prompts")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.slug).toBe("prompt-a")
      expect(ops[0].row.deleted_at).toBeNull()
    }
  })

  test("emits an upsert when updatedAt advances", () => {
    const prev = [make("a")]
    const next = [
      make("a", { updatedAt: new Date("2026-05-23T01:00:00Z"), name: "Renamed" }),
    ]
    const ops = diffPrompts(prev, next)
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    if (ops[0].kind === "upsert") expect(ops[0].row.name).toBe("Renamed")
  })

  test("emits an upsert when deletedAt flips on (soft-delete tombstone, not a hard delete)", () => {
    const prev = [make("a")]
    const next = [
      make("a", {
        updatedAt: new Date("2026-05-23T02:00:00Z"),
        deletedAt: new Date("2026-05-23T02:00:00Z"),
      }),
    ]
    const ops = diffPrompts(prev, next)
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    if (ops[0].kind === "upsert") {
      expect(typeof ops[0].row.deleted_at).toBe("string")
    }
  })

  test("emits an upsert when deletedAt flips back to null (restore)", () => {
    const prev = [
      make("a", { deletedAt: new Date("2026-05-23T02:00:00Z") }),
    ]
    const next = [
      make("a", {
        updatedAt: new Date("2026-05-23T03:00:00Z"),
        // deletedAt omitted ⇒ undefined ⇒ restored
      }),
    ]
    const ops = diffPrompts(prev, next)
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    if (ops[0].kind === "upsert") expect(ops[0].row.deleted_at).toBeNull()
  })

  test("emits a hard delete when a prompt vanishes from the next array", () => {
    const prev = [make("a"), make("b")]
    const next = [make("a")]
    const ops = diffPrompts(prev, next)
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
    if (ops[0].kind === "delete") {
      expect(ops[0].target).toBe("prompts")
      expect(ops[0].where).toEqual({ column: "id", value: "b" })
    }
  })

  test("variables list change triggers an upsert", () => {
    const prev = [make("a", { variables: ["name"] })]
    const next = [
      make("a", {
        variables: ["name", "topic"],
        updatedAt: new Date("2026-05-23T04:00:00Z"),
      }),
    ]
    const ops = diffPrompts(prev, next)
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.variables).toEqual(["name", "topic"])
    }
  })
})
