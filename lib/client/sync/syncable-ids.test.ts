import { describe, expect, test } from "bun:test"

import { useStore } from "@/client/hooks/use-store"
import { isUuid } from "@/shared/runs/ids"

import { remapReferences, replacementsFor } from "./syncable-ids"

describe("syncable ids", () => {
  test("the first-run scaffolding's ids are replaced, and only those", () => {
    // A fresh store: the first-run scaffolding.
    const fresh = useStore.getState()
    const ids = [...fresh.workspaces.map((w) => w.id), ...fresh.conversations.map((c) => c.id)]
    expect(ids.some((id) => !isUuid(id))).toBe(true)
    const map = replacementsFor([...ids, "8b2f7c6e-1d3a-4c5b-9e8f-0a1b2c3d4e5f"], {})
    expect([...map.keys()].sort()).toEqual([...ids].sort())
    for (const id of map.values()) expect(isUuid(id)).toBe(true)
  })

  test("a replacement another tab saved is reused", () => {
    const saved = { default: "11111111-1111-4111-8111-111111111111" }
    expect(replacementsFor(["default"], saved).get("default")).toBe(saved.default)
    expect(replacementsFor(["default"], { default: "not-a-uuid" }).get("default")).not.toBe("not-a-uuid")
  })

  test("every reference is rewritten, ids of other kinds and other text are not", () => {
    const map = new Map([
      ["default", "11111111-1111-4111-8111-111111111111"],
      ["demo-1", "22222222-2222-4222-8222-222222222222"],
    ])
    const state = {
      activeWorkspaceId: "default",
      activeConversationId: "demo-1",
      conversations: [{ id: "demo-1", workspaceId: "default", title: "default", parentId: "demo-1" }],
      notes: [{ id: "n1", workspaceId: "default", conversationId: "demo-1", messageId: "demo-1" }],
      conversationFiles: [{ conversationId: "demo-1", fileId: "default" }],
      projectTasks: [{ id: "t", workspaceId: "default", status: "todo" }],
      createdAt: new Date(0),
    }
    const out = remapReferences(state, map)
    expect(out).toEqual({
      activeWorkspaceId: "11111111-1111-4111-8111-111111111111",
      activeConversationId: "22222222-2222-4222-8222-222222222222",
      conversations: [
        {
          id: "demo-1",
          workspaceId: "11111111-1111-4111-8111-111111111111",
          title: "default",
          parentId: "22222222-2222-4222-8222-222222222222",
        },
      ],
      notes: [
        {
          id: "n1",
          workspaceId: "11111111-1111-4111-8111-111111111111",
          conversationId: "22222222-2222-4222-8222-222222222222",
          messageId: "demo-1",
        },
      ],
      conversationFiles: [{ conversationId: "22222222-2222-4222-8222-222222222222", fileId: "default" }],
      projectTasks: [{ id: "t", workspaceId: "11111111-1111-4111-8111-111111111111", status: "todo" }],
      createdAt: new Date(0),
    })
    expect(out.createdAt).toBeInstanceOf(Date)
    // Nothing to replace: the same object back.
    expect(remapReferences(state, new Map())).toBe(state)
  })
})
