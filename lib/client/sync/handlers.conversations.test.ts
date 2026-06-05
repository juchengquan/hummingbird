import { describe, expect, test } from "bun:test"
import type { Conversation, Message } from "@/shared/types"
import { diffConversations } from "./handlers"

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    role: "user",
    content: `m-${id}`,
    timestamp: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

function conv(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    workspaceId: "ws-1",
    title: `Conv ${id}`,
    messages: [],
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
    pinned: false,
    systemPrompt: "",
    selectedFileIds: [],
    ...overrides,
  }
}

describe("diffConversations", () => {
  test("no ops when identical", () => {
    expect(diffConversations([conv("a")], [conv("a")])).toEqual([])
  })

  test("upsert for a new conversation", () => {
    const ops = diffConversations([], [conv("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.workspace_id).toBe("ws-1")
      expect(ops[0].row.title).toBe("Conv a")
      expect(ops[0].row.pinned).toBe(false)
    }
  })

  test("header upsert when title changes; no message ops when messages unchanged", () => {
    const ops = diffConversations(
      [conv("a")],
      [conv("a", { title: "Renamed", updatedAt: new Date("2026-05-23T01:00:00Z") })]
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("conversations")
  })

  test("hard delete when a conversation vanishes; Postgres cascades messages", () => {
    const ops = diffConversations([conv("a"), conv("b")], [conv("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
    if (ops[0].kind === "delete") {
      expect(ops[0].target).toBe("conversations")
      expect(ops[0].where).toEqual({ column: "id", value: "b" })
    }
  })

  test("pinned change triggers header upsert", () => {
    const ops = diffConversations(
      [conv("a")],
      [conv("a", { pinned: true, updatedAt: new Date("2026-05-23T02:00:00Z") })]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") expect(ops[0].row.pinned).toBe(true)
  })

  test("selectedFileIds change triggers header upsert", () => {
    const ops = diffConversations(
      [conv("a", { selectedFileIds: ["f1"] })],
      [
        conv("a", {
          selectedFileIds: ["f1", "f2"],
          updatedAt: new Date("2026-05-23T03:00:00Z"),
        }),
      ]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.selected_file_ids).toEqual(["f1", "f2"])
    }
  })

  test("appending a message emits a message upsert with position", () => {
    const before = conv("a", { messages: [msg("m1")] })
    const after = conv("a", {
      messages: [msg("m1"), msg("m2")],
      updatedAt: new Date("2026-05-23T04:00:00Z"),
    })
    const ops = diffConversations([before], [after])
    // 1 header upsert (updatedAt advanced) + 1 message upsert for m2.
    const messageOps = ops.filter((o) => o.target === "messages")
    expect(messageOps).toHaveLength(1)
    if (messageOps[0].kind === "upsert") {
      expect(messageOps[0].row.id).toBe("m2")
      expect(messageOps[0].row.position).toBe(1)
      expect(messageOps[0].row.conversation_id).toBe("a")
    }
  })

  test("editing a message body emits an upsert", () => {
    const before = conv("a", { messages: [msg("m1", { content: "old" })] })
    const after = conv("a", {
      messages: [msg("m1", { content: "new" })],
    })
    const ops = diffConversations([before], [after])
    const messageOps = ops.filter((o) => o.target === "messages")
    expect(messageOps).toHaveLength(1)
    if (messageOps[0].kind === "upsert") {
      expect(messageOps[0].row.content).toBe("new")
    }
  })

  test("deleting a message emits a delete op", () => {
    const before = conv("a", { messages: [msg("m1"), msg("m2")] })
    const after = conv("a", { messages: [msg("m1")] })
    const ops = diffConversations([before], [after])
    const messageOps = ops.filter((o) => o.target === "messages")
    expect(messageOps).toHaveLength(1)
    expect(messageOps[0].kind).toBe("delete")
    if (messageOps[0].kind === "delete") {
      expect(messageOps[0].where).toEqual({ column: "id", value: "m2" })
    }
  })

  test("streaming conversation has its message diff suppressed", () => {
    const before = conv("a", { messages: [msg("m1")] })
    const after = conv("a", {
      messages: [msg("m1"), msg("m2", { content: "partial..." })],
    })
    const ops = diffConversations([before], [after], {
      streamingConversationIds: new Set(["a"]),
    })
    // No message ops while streaming. Header may or may not emit depending
    // on equality — assert only the message-suppression invariant.
    expect(ops.filter((o) => o.target === "messages")).toHaveLength(0)
  })
})
