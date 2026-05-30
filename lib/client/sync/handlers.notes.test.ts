import { describe, expect, test } from "bun:test"
import type { Note } from "@/shared/types"
import { diffNotes } from "./handlers"

function make(id: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    workspaceId: "ws-1",
    conversationId: "c-1",
    messageId: null,
    body: `note-${id}`,
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffNotes", () => {
  test("no ops when identical", () => {
    expect(diffNotes([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new note", () => {
    const ops = diffNotes([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("notes")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.workspace_id).toBe("ws-1")
      expect(ops[0].row.body).toBe("note-a")
    }
  })

  test("body edit triggers upsert", () => {
    const ops = diffNotes(
      [make("a", { body: "old" })],
      [
        make("a", {
          body: "new",
          updatedAt: new Date("2026-05-23T01:00:00Z"),
        }),
      ]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") expect(ops[0].row.body).toBe("new")
  })

  test("bookmark note (messageId set) round-trips", () => {
    const ops = diffNotes(
      [],
      [make("a", { messageId: "m-99", body: "bookmarked here" })]
    )
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.message_id).toBe("m-99")
    }
  })

  test("hard delete when a note vanishes", () => {
    const ops = diffNotes([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
  })
})
