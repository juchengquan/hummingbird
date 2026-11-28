import { describe, expect, test } from "bun:test"
import type { Artifact } from "@/shared/types"
import { diffArtifacts } from "./handlers"

function make(id: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    workspaceId: "ws-1",
    conversationId: "c-1",
    messageId: "m-1",
    kind: "code",
    language: "tsx",
    title: `Artifact ${id}`,
    content: "export const x = 1",
    storagePath: null,
    pinned: false,
    createdAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffArtifacts", () => {
  test("no ops when identical", () => {
    expect(diffArtifacts([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new artifact", () => {
    const ops = diffArtifacts([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("artifacts")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.kind).toBe("code")
      expect(ops[0].row.language).toBe("tsx")
      expect(ops[0].row.pinned).toBe(false)
    }
  })

  test("pinning an artifact triggers upsert", () => {
    const ops = diffArtifacts(
      [make("a")],
      [make("a", { pinned: true })]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") expect(ops[0].row.pinned).toBe(true)
  })

  test("title rename triggers upsert", () => {
    const ops = diffArtifacts(
      [make("a", { title: "Old" })],
      [make("a", { title: "New" })]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") expect(ops[0].row.title).toBe("New")
  })

  test("hard delete when an artifact vanishes", () => {
    const ops = diffArtifacts([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
  })

  test("artifact without a message ref (manual create) round-trips", () => {
    const ops = diffArtifacts(
      [],
      [make("a", { messageId: null, kind: "markdown", language: null })]
    )
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.message_id).toBeNull()
      expect(ops[0].row.language).toBeNull()
    }
  })
})
