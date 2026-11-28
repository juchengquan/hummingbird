import { describe, expect, test } from "bun:test"
import type { ConversationFile } from "@/shared/types"
import { diffConversationFiles } from "./handlers"

function make(
  id: string,
  overrides: Partial<ConversationFile> = {}
): ConversationFile {
  return {
    id,
    conversationId: "c-1",
    fileId: `file-${id}`,
    addedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffConversationFiles", () => {
  test("no ops when identical", () => {
    expect(diffConversationFiles([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new conversation-private file", () => {
    const ops = diffConversationFiles([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("conversation_files")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.conversation_id).toBe("c-1")
      expect(ops[0].row.file_id).toBe("file-a")
    }
  })

  test("hard delete when an attachment is removed from the conversation", () => {
    const ops = diffConversationFiles([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
    if (ops[0].kind === "delete") {
      expect(ops[0].where).toEqual({ column: "id", value: "b" })
    }
  })
})
