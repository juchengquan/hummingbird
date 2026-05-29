import { describe, expect, test } from "bun:test"
import type { ConversationMcpResource } from "@/shared/types"
import { diffConversationMcpResources } from "./handlers"

function make(
  id: string,
  overrides: Partial<ConversationMcpResource> = {}
): ConversationMcpResource {
  return {
    id,
    conversationId: "c-1",
    resourceId: `res-${id}`,
    addedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffConversationMcpResources", () => {
  test("no ops when identical", () => {
    expect(diffConversationMcpResources([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new conversation-private MCP attachment", () => {
    const ops = diffConversationMcpResources([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("conversation_mcp_resources")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.conversation_id).toBe("c-1")
      expect(ops[0].row.resource_id).toBe("res-a")
    }
  })

  test("hard delete when an attachment is removed", () => {
    const ops = diffConversationMcpResources(
      [make("a"), make("b")],
      [make("a")]
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
  })
})
