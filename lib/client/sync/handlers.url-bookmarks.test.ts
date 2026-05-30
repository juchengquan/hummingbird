import { describe, expect, test } from "bun:test"
import type { UrlBookmark } from "@/shared/types"
import { diffUrlBookmarks } from "./handlers"

function make(id: string, overrides: Partial<UrlBookmark> = {}): UrlBookmark {
  return {
    id,
    workspaceId: "ws-1",
    url: `https://example.com/${id}`,
    title: `Title ${id}`,
    content: `Content ${id}`,
    contentTruncated: false,
    fetchedAt: new Date("2026-05-23T00:00:00Z"),
    contentHash: `hash-${id}`,
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffUrlBookmarks", () => {
  test("no ops when identical", () => {
    expect(diffUrlBookmarks([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new bookmark", () => {
    const ops = diffUrlBookmarks([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("url_bookmarks")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.url).toBe("https://example.com/a")
      expect(ops[0].row.content_hash).toBe("hash-a")
    }
  })

  test("re-fetch (content + fetchedAt + hash bump) triggers upsert", () => {
    const ops = diffUrlBookmarks(
      [make("a")],
      [
        make("a", {
          content: "Updated body",
          contentHash: "new-hash",
          fetchedAt: new Date("2026-05-23T05:00:00Z"),
          updatedAt: new Date("2026-05-23T05:00:00Z"),
        }),
      ]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.content_hash).toBe("new-hash")
    }
  })

  test("soft-delete tombstone", () => {
    const ops = diffUrlBookmarks(
      [make("a")],
      [
        make("a", {
          deletedAt: new Date("2026-05-23T02:00:00Z"),
          updatedAt: new Date("2026-05-23T02:00:00Z"),
        }),
      ]
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.deleted_at).toBeTypeOf("string")
    }
  })

  test("hard delete when a bookmark vanishes outright", () => {
    const ops = diffUrlBookmarks([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
  })
})
