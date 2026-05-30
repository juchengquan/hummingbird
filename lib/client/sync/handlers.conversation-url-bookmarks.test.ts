import { describe, expect, test } from "bun:test"
import type { ConversationUrlBookmark } from "@/shared/types"
import { diffConversationUrlBookmarks } from "./handlers"

function make(
  id: string,
  overrides: Partial<ConversationUrlBookmark> = {}
): ConversationUrlBookmark {
  return {
    id,
    conversationId: "c-1",
    bookmarkId: `bm-${id}`,
    addedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffConversationUrlBookmarks", () => {
  test("no ops when identical", () => {
    expect(diffConversationUrlBookmarks([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new conversation bookmark", () => {
    const ops = diffConversationUrlBookmarks([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("conversation_url_bookmarks")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.conversation_id).toBe("c-1")
      expect(ops[0].row.bookmark_id).toBe("bm-a")
    }
  })

  test("hard delete when an attachment is removed", () => {
    const ops = diffConversationUrlBookmarks(
      [make("a"), make("b")],
      [make("a")]
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
  })
})
