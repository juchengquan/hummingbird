import { describe, expect, test } from "bun:test"

import type { Conversation, McpResource, UrlBookmark } from "@/shared/types"

import { attachedMcpResources, attachedUrlBookmarks } from "./context-sources"

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  workspaceId: "w",
  title: "Chat",
  messages: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
  pinned: false,
  systemPrompt: "",
  selectedFileIds: [],
  ...over,
})

const res = (id: string, over: Partial<McpResource> = {}): McpResource => ({
  id,
  workspaceId: "w",
  serverId: "s",
  uri: `u:${id}`,
  name: id,
  addedAt: new Date(0),
  ...over,
})

const bm = (id: string, over: Partial<UrlBookmark> = {}): UrlBookmark => ({
  id,
  workspaceId: "w",
  url: `https://x/${id}`,
  title: id,
  content: "",
  contentTruncated: false,
  fetchedAt: new Date(0),
  contentHash: "",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
})

describe("attachedMcpResources", () => {
  test("workspace-ticked then conversation-private, de-duped; unknown ids and tombstones dropped", () => {
    const out = attachedMcpResources(conv({ selectedMcpResourceIds: ["a", "gone", "dead"] }), {
      mcpResources: [res("a"), res("b"), res("dead", { deletedAt: new Date(0) })],
      conversationMcpResources: [
        { id: "x", conversationId: "c1", resourceId: "b", addedAt: new Date(0) },
        { id: "y", conversationId: "c1", resourceId: "a", addedAt: new Date(0) },
        { id: "z", conversationId: "other", resourceId: "b", addedAt: new Date(0) },
      ],
    })
    expect(out.map((r) => r.id)).toEqual(["a", "b"])
  })

  test("no conversation → none", () => {
    expect(attachedMcpResources(undefined, { mcpResources: [res("a")], conversationMcpResources: [] })).toEqual([])
  })
})

describe("attachedUrlBookmarks", () => {
  test("both lanes, de-duped, tombstones dropped", () => {
    const out = attachedUrlBookmarks(conv({ selectedUrlBookmarkIds: ["p", "q"] }), {
      urlBookmarks: [bm("p"), bm("q", { deletedAt: new Date(0) }), bm("r")],
      conversationUrlBookmarks: [
        { id: "1", conversationId: "c1", bookmarkId: "r", addedAt: new Date(0) },
        { id: "2", conversationId: "c1", bookmarkId: "p", addedAt: new Date(0) },
      ],
    })
    expect(out.map((b) => b.id)).toEqual(["p", "r"])
  })
})
