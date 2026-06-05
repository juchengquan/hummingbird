import { describe, expect, test } from "bun:test"
import type { Conversation, ConversationFile, UploadedFile } from "@/shared/types"

import { buildAttachments } from "./build-attachments"

function file(overrides: Partial<UploadedFile> = {}): UploadedFile {
  return {
    id: "f-1",
    name: "doc.txt",
    size: 100,
    type: "text/plain",
    uploadedAt: new Date("2026-01-01"),
    ...overrides,
  }
}

function conv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c-1",
    workspaceId: "ws-1",
    title: "Chat",
    messages: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    pinned: false,
    systemPrompt: "",
    selectedFileIds: [],
    ...overrides,
  }
}

function cFile(
  conversationId: string,
  fileId: string,
  id = `cf-${conversationId}-${fileId}`
): ConversationFile {
  return { id, conversationId, fileId, addedAt: new Date("2026-01-01") }
}

describe("buildAttachments", () => {
  test("no conversation → empty", () => {
    const out = buildAttachments({
      conversation: null,
      files: [file({ id: "f-1" })],
      conversationFiles: [],
    })
    expect(out.attachedFileIds).toEqual([])
    expect(out.attachedFiles).toEqual([])
    expect(out.attachedImageUrls).toEqual([])
  })

  test("workspace-ticked files only", () => {
    const files = [file({ id: "a" }), file({ id: "b" }), file({ id: "c" })]
    const out = buildAttachments({
      conversation: conv({ selectedFileIds: ["a", "c"] }),
      files,
      conversationFiles: [],
    })
    expect(out.attachedFileIds).toEqual(["a", "c"])
    expect(out.attachedFiles.map((f) => f.id)).toEqual(["a", "c"])
  })

  test("conversation-private files only", () => {
    const files = [file({ id: "a" }), file({ id: "b" })]
    const out = buildAttachments({
      conversation: conv({ selectedFileIds: [] }),
      files,
      conversationFiles: [cFile("c-1", "b")],
    })
    expect(out.attachedFileIds).toEqual(["b"])
  })

  test("union of both lanes; de-dup keeps the workspace-lane order first", () => {
    const files = [file({ id: "a" }), file({ id: "b" }), file({ id: "c" })]
    const out = buildAttachments({
      conversation: conv({ selectedFileIds: ["a", "b"] }),
      files,
      conversationFiles: [cFile("c-1", "b"), cFile("c-1", "c")],
    })
    // workspace ids first (a, b), then private ids that aren't already in (c).
    expect(out.attachedFileIds).toEqual(["a", "b", "c"])
  })

  test("tombstoned files drop out of attachedFiles + image URLs but ids stay (chip placeholder)", () => {
    const files = [
      file({ id: "a" }),
      file({ id: "b", deletedAt: new Date("2026-01-02") }),
    ]
    const out = buildAttachments({
      conversation: conv({ selectedFileIds: ["a", "b"] }),
      files,
      conversationFiles: [],
    })
    expect(out.attachedFileIds).toEqual(["a", "b"])
    expect(out.attachedFiles.map((f) => f.id)).toEqual(["a"])
  })

  test("conversation-private files from a different conversation don't leak", () => {
    const files = [file({ id: "a" }), file({ id: "x" })]
    const out = buildAttachments({
      conversation: conv({ id: "c-1" }),
      files,
      conversationFiles: [cFile("c-2", "x")],
    })
    expect(out.attachedFileIds).toEqual([])
  })

  test("images: data-URL files with extractedKind='image' become attachedImageUrls", () => {
    const files = [
      file({ id: "doc" }),
      file({
        id: "pic",
        extractedKind: "image",
        imageDataUrl: "data:image/png;base64,abc",
      }),
    ]
    const out = buildAttachments({
      conversation: conv({ selectedFileIds: ["doc", "pic"] }),
      files,
      conversationFiles: [],
    })
    expect(out.attachedImageUrls).toEqual(["data:image/png;base64,abc"])
  })

  test("image file without an imageDataUrl is skipped from image URLs", () => {
    const files = [
      file({ id: "pic", extractedKind: "image" }), // no imageDataUrl
    ]
    const out = buildAttachments({
      conversation: conv({ selectedFileIds: ["pic"] }),
      files,
      conversationFiles: [],
    })
    expect(out.attachedImageUrls).toEqual([])
  })

  test("missing file ids (sync lag) are skipped from attachedFiles", () => {
    const out = buildAttachments({
      conversation: conv({ selectedFileIds: ["ghost"] }),
      files: [],
      conversationFiles: [],
    })
    expect(out.attachedFileIds).toEqual(["ghost"])
    expect(out.attachedFiles).toEqual([])
  })
})
