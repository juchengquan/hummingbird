import { describe, expect, test } from "bun:test"

import type { McpResource, UploadedFile, UrlBookmark } from "@/shared/types"

import { RUN_ATTACHMENTS_MAX, runAttachmentsFor } from "./attachments"

const file = (over: Partial<UploadedFile> & { id: string }): UploadedFile => ({
  name: `${over.id}.txt`,
  size: 10,
  type: "text/plain",
  uploadedAt: new Date(0),
  ...over,
})

const resource: McpResource = {
  id: "r1",
  workspaceId: "w",
  serverId: "srv",
  uri: "file:///README.md",
  name: "README.md",
  mimeType: "text/markdown",
  addedAt: new Date(0),
}

const bookmark = (over: Partial<UrlBookmark> = {}): UrlBookmark => ({
  id: "b1",
  workspaceId: "w",
  url: "https://example.com/",
  title: "Example",
  content: "page text",
  contentTruncated: false,
  fetchedAt: new Date("2026-05-21T00:00:00Z"),
  contentHash: "h",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
})

describe("runAttachmentsFor", () => {
  test("signed in: files by id (no text), RAG mode kept; MCP resources by reference; bookmarks with text", () => {
    const out = runAttachmentsFor({
      files: [
        file({ id: "f1", name: "a.pdf", type: "application/pdf", extractedKind: "pdf", extractedText: "secret text" }),
        file({ id: "f2", name: "pic.png", type: "image/png", extractedKind: "image", imageDataUrl: "data:image/png;base64,AAAA" }),
        file({ id: "f3", extractedText: "big" }),
      ],
      retrievalModes: { f3: "rag" },
      mcpResources: [resource],
      bookmarks: [bookmark({ contentTruncated: true })],
      cloud: true,
    })
    expect(out).toEqual([
      { kind: "file", fileId: "f1", name: "a.pdf", mimeType: "application/pdf", sizeBytes: 10, extractedKind: "pdf" },
      { kind: "file", fileId: "f2", name: "pic.png", mimeType: "image/png", sizeBytes: 10, extractedKind: "image" },
      { kind: "file", fileId: "f3", name: "f3.txt", mimeType: "text/plain", sizeBytes: 10, retrievalMode: "rag" },
      { kind: "mcpResource", id: "r1", serverId: "srv", uri: "file:///README.md", name: "README.md", mimeType: "text/markdown" },
      {
        kind: "bookmark",
        id: "b1",
        url: "https://example.com/",
        title: "Example",
        text: "page text",
        truncated: true,
        fetchedAt: "2026-05-21T00:00:00.000Z",
      },
    ])
    // Never any file bytes or text for a signed-in run (Q44).
    expect(JSON.stringify(out)).not.toContain("secret text")
    expect(JSON.stringify(out)).not.toContain("base64")
  })

  test("anonymous: files by value — text and the extraction's truncated flag; a RAG-mode file goes inline", () => {
    const out = runAttachmentsFor({
      files: [
        file({ id: "f1", extractedText: "alpha", extractionTruncated: true }),
        file({ id: "f2", extractedText: "beta" }),
        file({ id: "f3", name: "x.bin", type: "application/octet-stream" }),
      ],
      retrievalModes: { f2: "rag" },
      cloud: false,
    })
    expect(out).toEqual([
      { kind: "inlineFile", name: "f1.txt", mimeType: "text/plain", sizeBytes: 10, text: "alpha", truncated: true },
      { kind: "inlineFile", name: "f2.txt", mimeType: "text/plain", sizeBytes: 10, text: "beta" },
      { kind: "inlineFile", name: "x.bin", mimeType: "application/octet-stream", sizeBytes: 10 },
    ])
  })

  test("text past the attachment budget is cut one character past what the renderer has left", () => {
    const out = runAttachmentsFor({
      files: [file({ id: "f1", extractedText: "a".repeat(60) }), file({ id: "f2", extractedText: "b".repeat(60) })],
      bookmarks: [bookmark({ content: "c".repeat(60) })],
      cloud: false,
      budget: 100,
    })
    const texts = out.map((a) => ("text" in a ? a.text : undefined))
    // 60 fits; then 100 - 60 + 1 = 41 chars; then nothing is left: 1 char
    // (still a body, so the renderer lists it as omitted).
    expect(texts.map((t) => t?.length)).toEqual([60, 41, 1])
  })

  test("a signed-in run counts its cloud files' known text toward the budget", () => {
    const out = runAttachmentsFor({
      files: [file({ id: "f1", extractedText: "a".repeat(90) }), file({ id: "f2", extractedText: "r".repeat(90) })],
      retrievalModes: { f2: "rag" },
      bookmarks: [bookmark({ content: "c".repeat(60) })],
      cloud: true,
      budget: 100,
    })
    expect(out[2]).toMatchObject({ kind: "bookmark", text: "c".repeat(11) })
  })

  test("at most the contract's 40, files first", () => {
    const files = Array.from({ length: 45 }, (_, i) => file({ id: `f${i}` }))
    const out = runAttachmentsFor({ files, bookmarks: [bookmark()], cloud: true })
    expect(out).toHaveLength(RUN_ATTACHMENTS_MAX)
    expect(out.every((a) => a.kind === "file")).toBe(true)
  })

  test("nothing attached → empty", () => {
    expect(runAttachmentsFor({ files: [], cloud: true })).toEqual([])
  })
})
