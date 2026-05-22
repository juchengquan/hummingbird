import { describe, expect, test } from "bun:test"
import {
  forkConversationJoins,
  gcOrphanedAttachment,
  gcOrphanedAttachments,
  hasLiveReference,
  tombstoneFile,
  tombstoneMcpResource,
  tombstoneUrlBookmark,
  type AttachmentRef,
  type CascadeStateView,
} from "./cascade"

const emptyState: CascadeStateView = {
  files: [],
  resources: [],
  conversationFiles: [],
  mcpResources: [],
  mcpResourceBindings: [],
  conversationMcpResources: [],
  urlBookmarks: [],
  conversationUrlBookmarks: [],
  conversations: [],
}

const baseConv = (overrides: Partial<CascadeStateView["conversations"][number]>) => ({
  id: "c",
  workspaceId: "w",
  title: "t",
  messages: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  pinned: false,
  selectedFileIds: [],
  ...overrides,
})

describe("hasLiveReference", () => {
  test("no refs anywhere → false (all three kinds)", () => {
    expect(hasLiveReference(emptyState, { kind: "file", id: "f1" })).toBe(false)
    expect(hasLiveReference(emptyState, { kind: "mcp_resource", id: "m1" })).toBe(false)
    expect(hasLiveReference(emptyState, { kind: "url_bookmark", id: "u1" })).toBe(false)
  })

  test("file: workspace `resources` row keeps it live", () => {
    const state = { ...emptyState, resources: [{ id: "r1", workspaceId: "w", fileId: "f1", addedAt: new Date() }] }
    expect(hasLiveReference(state, { kind: "file", id: "f1" })).toBe(true)
  })

  test("file: private conversationFiles join keeps it live", () => {
    const state = { ...emptyState, conversationFiles: [{ id: "cf1", conversationId: "c", fileId: "f1", addedAt: new Date() }] }
    expect(hasLiveReference(state, { kind: "file", id: "f1" })).toBe(true)
  })

  test("file: any conversation's selectedFileIds keeps it live", () => {
    const state = { ...emptyState, conversations: [baseConv({ selectedFileIds: ["f1"] })] }
    expect(hasLiveReference(state, { kind: "file", id: "f1" })).toBe(true)
  })

  test("mcp_resource: binding keeps it live", () => {
    const state = { ...emptyState, mcpResourceBindings: [{ id: "b1", workspaceId: "w", resourceId: "m1", addedAt: new Date() }] }
    expect(hasLiveReference(state, { kind: "mcp_resource", id: "m1" })).toBe(true)
  })

  test("mcp_resource: private conversation join keeps it live", () => {
    const state = { ...emptyState, conversationMcpResources: [{ id: "cmr1", conversationId: "c", resourceId: "m1", addedAt: new Date() }] }
    expect(hasLiveReference(state, { kind: "mcp_resource", id: "m1" })).toBe(true)
  })

  test("url_bookmark: private conversation join keeps it live", () => {
    const state = { ...emptyState, conversationUrlBookmarks: [{ id: "cub1", conversationId: "c", bookmarkId: "u1", addedAt: new Date() }] }
    expect(hasLiveReference(state, { kind: "url_bookmark", id: "u1" })).toBe(true)
  })

  test("url_bookmark: selectedUrlBookmarkIds keeps it live", () => {
    const state = { ...emptyState, conversations: [baseConv({ selectedUrlBookmarkIds: ["u1"] })] }
    expect(hasLiveReference(state, { kind: "url_bookmark", id: "u1" })).toBe(true)
  })
})

describe("gcOrphanedAttachment", () => {
  test("live ref → empty patch (no-op)", () => {
    const state = {
      ...emptyState,
      files: [{ id: "f1", name: "x", size: 1, type: "t", uploadedAt: new Date() }],
      resources: [{ id: "r1", workspaceId: "w", fileId: "f1", addedAt: new Date() }],
    }
    expect(gcOrphanedAttachment(state, { kind: "file", id: "f1" })).toEqual({})
  })

  test("no refs → file is tombstoned", () => {
    const state = {
      ...emptyState,
      files: [{ id: "f1", name: "x", size: 1, type: "t", uploadedAt: new Date() }],
    }
    const patch = gcOrphanedAttachment(state, { kind: "file", id: "f1" })
    expect(patch.files?.[0].deletedAt).toBeInstanceOf(Date)
  })

  test("tombstoneFile preserves identity, drops content fields", () => {
    const f = {
      id: "f1", name: "x.txt", size: 100, type: "text/plain",
      uploadedAt: new Date(),
      // any field not on the tombstone whitelist gets dropped:
      extractedText: "hello world",
      summary: "...",
    } as Parameters<typeof tombstoneFile>[0]
    const t = tombstoneFile(f)
    expect(t.id).toBe("f1")
    expect(t.name).toBe("x.txt")
    expect(t.size).toBe(100)
    expect(t.deletedAt).toBeInstanceOf(Date)
    expect((t as unknown as Record<string, unknown>).extractedText).toBeUndefined()
  })

  test("tombstoneUrlBookmark keeps id/url/title, drops content + description + faviconUrl", () => {
    const u = {
      id: "u1", workspaceId: "w", url: "https://x", title: "T",
      content: "BODY", contentTruncated: false, fetchedAt: new Date(),
      contentHash: "abc", createdAt: new Date(), updatedAt: new Date(),
      description: "D", faviconUrl: "F",
    } as Parameters<typeof tombstoneUrlBookmark>[0]
    const t = tombstoneUrlBookmark(u)
    expect(t.url).toBe("https://x")
    expect(t.title).toBe("T")
    expect(t.content).toBe("")
    expect((t as unknown as Record<string, unknown>).description).toBeUndefined()
    expect((t as unknown as Record<string, unknown>).faviconUrl).toBeUndefined()
    expect(t.deletedAt).toBeInstanceOf(Date)
  })

  test("tombstoneMcpResource keeps addressing tuple", () => {
    const r = {
      id: "m1", workspaceId: "w", serverId: "s", uri: "x://y",
      name: "N", addedAt: new Date(),
    } as Parameters<typeof tombstoneMcpResource>[0]
    const t = tombstoneMcpResource(r)
    expect(t.workspaceId).toBe("w")
    expect(t.serverId).toBe("s")
    expect(t.uri).toBe("x://y")
    expect(t.name).toBe("N")
    expect(t.deletedAt).toBeInstanceOf(Date)
  })
})

describe("gcOrphanedAttachments (bulk)", () => {
  test("all three kinds orphaned → all tombstoned in one patch", () => {
    const state = {
      ...emptyState,
      files: [{ id: "f", name: "x", size: 1, type: "t", uploadedAt: new Date() }],
      mcpResources: [{ id: "m", workspaceId: "w", serverId: "s", uri: "x", name: "n", addedAt: new Date() }],
      urlBookmarks: [{
        id: "u", workspaceId: "w", url: "x", title: "t", content: "", contentTruncated: false,
        fetchedAt: new Date(), contentHash: "h", createdAt: new Date(), updatedAt: new Date(),
      }],
    }
    const refs: AttachmentRef[] = [
      { kind: "file", id: "f" },
      { kind: "mcp_resource", id: "m" },
      { kind: "url_bookmark", id: "u" },
    ]
    const patch = gcOrphanedAttachments(state, refs)
    expect(patch.files?.find((f) => f.id === "f")?.deletedAt).toBeInstanceOf(Date)
    expect(patch.mcpResources?.find((r) => r.id === "m")?.deletedAt).toBeInstanceOf(Date)
    expect(patch.urlBookmarks?.find((b) => b.id === "u")?.deletedAt).toBeInstanceOf(Date)
  })

  test("live ref skipped", () => {
    const state = {
      ...emptyState,
      files: [{ id: "f", name: "x", size: 1, type: "t", uploadedAt: new Date() }],
      resources: [{ id: "r", workspaceId: "w", fileId: "f", addedAt: new Date() }],
    }
    const patch = gcOrphanedAttachments(state, [{ kind: "file", id: "f" }])
    expect(patch.files).toBeUndefined()
  })

  test("dedup: same ref 3× yields one tombstone (not three)", () => {
    const state = {
      ...emptyState,
      files: [{ id: "f", name: "x", size: 1, type: "t", uploadedAt: new Date() }],
    }
    const patch = gcOrphanedAttachments(state, [
      { kind: "file", id: "f" },
      { kind: "file", id: "f" },
      { kind: "file", id: "f" },
    ])
    const tombstones = (patch.files ?? []).filter((f) => f.deletedAt)
    expect(tombstones).toHaveLength(1)
  })

  test("parity with the singular helper across mixed live + orphan refs", () => {
    const state = {
      ...emptyState,
      files: [
        { id: "f-orphan", name: "o", size: 1, type: "t", uploadedAt: new Date() },
        { id: "f-live", name: "l", size: 1, type: "t", uploadedAt: new Date() },
      ],
      resources: [{ id: "r1", workspaceId: "w", fileId: "f-live", addedAt: new Date() }],
      mcpResources: [{ id: "m-orphan", workspaceId: "w", serverId: "s", uri: "x", name: "n", addedAt: new Date() }],
      urlBookmarks: [{
        id: "u-live", workspaceId: "w", url: "x", title: "t", content: "", contentTruncated: false,
        fetchedAt: new Date(), contentHash: "h", createdAt: new Date(), updatedAt: new Date(),
      }],
      conversations: [baseConv({ selectedUrlBookmarkIds: ["u-live"] })],
    }
    const refs: AttachmentRef[] = [
      { kind: "file", id: "f-orphan" },
      { kind: "file", id: "f-live" },
      { kind: "mcp_resource", id: "m-orphan" },
      { kind: "url_bookmark", id: "u-live" },
    ]
    const pluralPatch = gcOrphanedAttachments(state, refs)
    // Replicate the old singular-helper path
    let view = state
    let singularPatch: typeof pluralPatch = {}
    for (const ref of refs) {
      const p = gcOrphanedAttachment(view, ref)
      if (p.files) view = { ...view, files: p.files }
      if (p.mcpResources) view = { ...view, mcpResources: p.mcpResources }
      if (p.urlBookmarks) view = { ...view, urlBookmarks: p.urlBookmarks }
      singularPatch = { ...singularPatch, ...p }
    }
    const pluralFiles = pluralPatch.files?.filter((f) => f.deletedAt).map((f) => f.id).sort()
    const singularFiles = singularPatch.files?.filter((f) => f.deletedAt).map((f) => f.id).sort()
    expect(pluralFiles).toEqual(singularFiles)
    expect(pluralPatch.urlBookmarks).toBeUndefined()
    expect(singularPatch.urlBookmarks).toBeUndefined()
  })
})

describe("forkConversationJoins", () => {
  test("copies all three private-join lanes with fresh row ids", () => {
    let i = 0
    const fakeUuid = () => `new-${++i}`
    const state = {
      conversationFiles: [{ id: "old1", conversationId: "src", fileId: "f1", addedAt: new Date() }],
      conversationMcpResources: [{ id: "old2", conversationId: "src", resourceId: "m1", addedAt: new Date() }],
      conversationUrlBookmarks: [{ id: "old3", conversationId: "src", bookmarkId: "u1", addedAt: new Date() }],
    }
    const inherited = forkConversationJoins(state, "src", "fork", fakeUuid)
    expect(inherited.conversationFiles).toHaveLength(1)
    expect(inherited.conversationFiles[0].conversationId).toBe("fork")
    expect(inherited.conversationFiles[0].id).not.toBe("old1")
    expect(inherited.conversationMcpResources[0].conversationId).toBe("fork")
    expect(inherited.conversationUrlBookmarks[0].conversationId).toBe("fork")
  })

  test("source's joins outside this conversation are not copied", () => {
    let i = 0
    const fakeUuid = () => `new-${++i}`
    const state = {
      conversationFiles: [
        { id: "old1", conversationId: "src", fileId: "f1", addedAt: new Date() },
        { id: "old2", conversationId: "other", fileId: "f2", addedAt: new Date() },
      ],
      conversationMcpResources: [],
      conversationUrlBookmarks: [],
    }
    const inherited = forkConversationJoins(state, "src", "fork", fakeUuid)
    expect(inherited.conversationFiles).toHaveLength(1)
    expect(inherited.conversationFiles[0].fileId).toBe("f1")
  })
})
