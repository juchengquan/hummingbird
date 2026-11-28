import { describe, expect, test } from "bun:test"

import type { UploadedFile, UrlBookmark } from "@/shared/types"

import {
  isTypingAttachmentMention,
  matchAttachmentMentions,
  MAX_ATTACHMENT_MENTION_MATCHES,
} from "./parser"

function file(id: string, name: string, type = "text/plain"): UploadedFile {
  return {
    id,
    name,
    size: 1234,
    type,
    uploadedAt: new Date(0),
  }
}

function tombstoned(f: UploadedFile): UploadedFile {
  return { ...f, deletedAt: new Date(0) }
}

function bookmark(id: string, title: string, url: string): UrlBookmark {
  return {
    id,
    workspaceId: "w1",
    url,
    title,
    content: "",
    contentTruncated: false,
    fetchedAt: new Date(0),
    contentHash: "",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

const emptySources = {
  workspaceFiles: [],
  privateFiles: [],
  bookmarks: [],
}

describe("isTypingAttachmentMention", () => {
  test("fires on a bare `#`", () => {
    expect(isTypingAttachmentMention("#")).toBe(true)
  })
  test("fires while typing `#fo`", () => {
    expect(isTypingAttachmentMention("#fo")).toBe(true)
  })
  test("closes once whitespace appears (markdown heading case)", () => {
    expect(isTypingAttachmentMention("# heading")).toBe(false)
    expect(isTypingAttachmentMention("#tag word")).toBe(false)
  })
  test("never fires when `#` isn't the first char", () => {
    expect(isTypingAttachmentMention(" #foo")).toBe(false)
    expect(isTypingAttachmentMention("see #foo")).toBe(false)
  })
  test("empty string is not typing a mention", () => {
    expect(isTypingAttachmentMention("")).toBe(false)
  })
})

describe("matchAttachmentMentions", () => {
  test("empty partial returns every live item, ordered files first then bookmarks", () => {
    const out = matchAttachmentMentions("", {
      workspaceFiles: [file("f1", "alpha.txt"), file("f2", "beta.pdf")],
      privateFiles: [file("pf1", "personal.md")],
      bookmarks: [bookmark("b1", "Anthropic", "https://anthropic.com")],
    })
    expect(out.map((x) => x.kind)).toEqual([
      "workspaceFile",
      "workspaceFile",
      "conversationFile",
      "bookmark",
    ])
  })

  test("name-prefix beats name-substring within a kind", () => {
    const out = matchAttachmentMentions("re", {
      workspaceFiles: [
        file("f1", "core.txt"), // substring "re" at offset 2
        file("f2", "research.md"), // prefix "re"
      ],
      privateFiles: [],
      bookmarks: [],
    })
    // research.md ranks 0, core.txt ranks 1 — prefix first
    expect(out.map((x) => "id" in x ? x.id : "")).toEqual(["f2", "f1"])
  })

  test("URL-substring fallback on bookmarks (title miss)", () => {
    const out = matchAttachmentMentions("anth", {
      workspaceFiles: [],
      privateFiles: [],
      bookmarks: [
        bookmark("b1", "Constitutional AI paper", "https://anthropic.com/research"),
      ],
    })
    expect(out).toHaveLength(1)
    if (out[0].kind === "bookmark") {
      expect(out[0].id).toBe("b1")
    }
  })

  test("tombstoned items are filtered out", () => {
    const live = file("f1", "live.txt")
    const dead = tombstoned(file("f2", "dead.txt"))
    const out = matchAttachmentMentions("", {
      workspaceFiles: [live, dead],
      privateFiles: [],
      bookmarks: [],
    })
    expect(out.map((x) => "id" in x ? x.id : "")).toEqual(["f1"])
  })

  test("results are capped at MAX_ATTACHMENT_MENTION_MATCHES", () => {
    const many = Array.from({ length: 20 }, (_, i) => file(`f${i}`, `file-${i}.txt`))
    const out = matchAttachmentMentions("", {
      workspaceFiles: many,
      privateFiles: [],
      bookmarks: [],
    })
    expect(out.length).toBe(MAX_ATTACHMENT_MENTION_MATCHES)
  })

  test("workspace files come before private files even when private files prefix-match", () => {
    // Decision pinned: ordering across kinds is fixed (workspace →
    // private → bookmarks). Within a kind, ranking is by match
    // quality. A private file with a better rank does NOT promote
    // ahead of a workspace file with a worse rank — the kind ordering
    // wins. This keeps the menu shape predictable.
    const out = matchAttachmentMentions("re", {
      workspaceFiles: [file("ws1", "core.txt")], // substring
      privateFiles: [file("pf1", "research.md")], // prefix
      bookmarks: [],
    })
    expect(out.map((x) => "id" in x ? x.id : "")).toEqual(["ws1", "pf1"])
  })

  test("no matches when nothing fits the needle", () => {
    const out = matchAttachmentMentions("xyz", {
      workspaceFiles: [file("f1", "alpha.txt")],
      privateFiles: [],
      bookmarks: [bookmark("b1", "Anthropic", "https://anthropic.com")],
    })
    expect(out).toEqual([])
  })

  test("respects emptySources without crashing", () => {
    expect(matchAttachmentMentions("any", emptySources)).toEqual([])
    expect(matchAttachmentMentions("", emptySources)).toEqual([])
  })
})
