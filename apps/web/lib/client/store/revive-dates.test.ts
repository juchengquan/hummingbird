import { describe, expect, test } from "bun:test"
import { reviveDates } from "./revive-dates"

const ISO = "2026-05-21T12:34:56.789Z"

function seed() {
  return {
    workspaces: [{ id: "w", name: "W", createdAt: ISO, updatedAt: ISO }],
    conversations: [
      {
        id: "c",
        workspaceId: "w",
        title: "T",
        pinned: false,
        selectedFileIds: [],
        messages: [
          { id: "m1", role: "user", content: "Hi", timestamp: ISO },
          { id: "m2", role: "assistant", content: "Hello", timestamp: ISO },
        ],
        createdAt: ISO,
        updatedAt: ISO,
      },
    ],
    files: [{ id: "f", name: "x", size: 1, type: "t", uploadedAt: ISO, deletedAt: ISO }],
    resources: [{ id: "r", workspaceId: "w", fileId: "f", addedAt: ISO }],
    conversationFiles: [{ id: "cf", conversationId: "c", fileId: "f", addedAt: ISO }],
    mcpServers: [{
      id: "s", name: "S", workspaceId: "w", url: "x", transport: "http",
      credentialMode: "local", enabled: true,
      createdAt: ISO, updatedAt: ISO, deletedAt: ISO,
    }],
    mcpResources: [{ id: "mr", workspaceId: "w", serverId: "s", uri: "u", name: "N", addedAt: ISO, deletedAt: ISO }],
    mcpResourceBindings: [{ id: "b", workspaceId: "w", resourceId: "mr", addedAt: ISO }],
    conversationMcpResources: [{ id: "cmr", conversationId: "c", resourceId: "mr", addedAt: ISO }],
    urlBookmarks: [{
      id: "u", workspaceId: "w", url: "x", title: "T", content: "",
      contentTruncated: false, fetchedAt: ISO, contentHash: "h",
      createdAt: ISO, updatedAt: ISO, deletedAt: ISO,
    }],
    conversationUrlBookmarks: [{ id: "cub", conversationId: "c", bookmarkId: "u", addedAt: ISO }],
    notes: [{ id: "n", workspaceId: "w", conversationId: "c", messageId: null, content: "x", createdAt: ISO, updatedAt: ISO }],
    artifacts: [{
      id: "a", workspaceId: "w", conversationId: "c", messageId: null,
      kind: "code", language: null, title: "T", content: "x",
      storagePath: null, pinned: false, createdAt: ISO,
    }],
    documents: [{ id: "d", workspaceId: "w", title: "T", content: "x", createdAt: ISO, updatedAt: ISO }],
  }
}

describe("reviveDates — every persisted slice + field", () => {
  test("workspaces.createdAt/updatedAt", () => {
    const s = seed(); reviveDates(s)
    expect(s.workspaces[0].createdAt).toBeInstanceOf(Date)
    expect(s.workspaces[0].updatedAt).toBeInstanceOf(Date)
  })
  test("conversations.createdAt/updatedAt", () => {
    const s = seed(); reviveDates(s)
    expect(s.conversations[0].createdAt).toBeInstanceOf(Date)
    expect(s.conversations[0].updatedAt).toBeInstanceOf(Date)
  })
  test("messages[].timestamp (nested under conversations)", () => {
    const s = seed(); reviveDates(s)
    expect(s.conversations[0].messages[0].timestamp).toBeInstanceOf(Date)
    expect(s.conversations[0].messages[1].timestamp).toBeInstanceOf(Date)
  })
  test("files.uploadedAt + optional deletedAt", () => {
    const s = seed(); reviveDates(s)
    expect(s.files[0].uploadedAt).toBeInstanceOf(Date)
    expect(s.files[0].deletedAt).toBeInstanceOf(Date)
  })
  test("resources / conversationFiles addedAt", () => {
    const s = seed(); reviveDates(s)
    expect(s.resources[0].addedAt).toBeInstanceOf(Date)
    expect(s.conversationFiles[0].addedAt).toBeInstanceOf(Date)
  })
  test("mcpServers all 3 timestamps", () => {
    const s = seed(); reviveDates(s)
    expect(s.mcpServers[0].createdAt).toBeInstanceOf(Date)
    expect(s.mcpServers[0].updatedAt).toBeInstanceOf(Date)
    expect(s.mcpServers[0].deletedAt).toBeInstanceOf(Date)
  })
  test("mcpResources / mcpResourceBindings / conversationMcpResources", () => {
    const s = seed(); reviveDates(s)
    expect(s.mcpResources[0].addedAt).toBeInstanceOf(Date)
    expect(s.mcpResources[0].deletedAt).toBeInstanceOf(Date)
    expect(s.mcpResourceBindings[0].addedAt).toBeInstanceOf(Date)
    expect(s.conversationMcpResources[0].addedAt).toBeInstanceOf(Date)
  })
  test("urlBookmarks 4 timestamps", () => {
    const s = seed(); reviveDates(s)
    expect(s.urlBookmarks[0].fetchedAt).toBeInstanceOf(Date)
    expect(s.urlBookmarks[0].createdAt).toBeInstanceOf(Date)
    expect(s.urlBookmarks[0].updatedAt).toBeInstanceOf(Date)
    expect(s.urlBookmarks[0].deletedAt).toBeInstanceOf(Date)
  })
  test("conversationUrlBookmarks.addedAt", () => {
    const s = seed(); reviveDates(s)
    expect(s.conversationUrlBookmarks[0].addedAt).toBeInstanceOf(Date)
  })
  test("notes / artifacts / documents createdAt+updatedAt", () => {
    const s = seed(); reviveDates(s)
    expect(s.notes[0].createdAt).toBeInstanceOf(Date)
    expect(s.notes[0].updatedAt).toBeInstanceOf(Date)
    expect(s.artifacts[0].createdAt).toBeInstanceOf(Date)
    expect(s.documents[0].createdAt).toBeInstanceOf(Date)
    expect(s.documents[0].updatedAt).toBeInstanceOf(Date)
  })
})

describe("reviveDates — invariants", () => {
  test("ISO value round-trips exactly", () => {
    const s = seed(); reviveDates(s)
    // After reviveDates, the field is a real Date — but the inferred type
    // is still `string` because we mutate in place. Cast to inspect.
    expect((s.urlBookmarks[0].fetchedAt as unknown as Date).toISOString()).toBe(ISO)
  })

  test("already-Date stays the same object reference (no double-conversion)", () => {
    const realDate = new Date(ISO)
    const s = { workspaces: [{ id: "w", name: "W", createdAt: realDate, updatedAt: ISO }] }
    reviveDates(s)
    expect(s.workspaces[0].createdAt).toBe(realDate)
    expect(s.workspaces[0].updatedAt).toBeInstanceOf(Date)
  })

  test("missing optional fields are not invented", () => {
    const s = { files: [{ id: "f", name: "x", size: 1, type: "t", uploadedAt: ISO }] }
    reviveDates(s)
    expect("deletedAt" in s.files[0]).toBe(false)
  })

  test("empty / null / malformed input doesn't throw", () => {
    expect(() => reviveDates({})).not.toThrow()
    expect(() => reviveDates({ workspaces: null as unknown as never })).not.toThrow()
    expect(() => reviveDates({
      workspaces: [null, undefined, { id: "w", name: "W" }] as unknown as never,
    })).not.toThrow()
  })

  test("conversation without messages array doesn't crash", () => {
    const s = { conversations: [{ id: "c", workspaceId: "w" }] }
    expect(() => reviveDates(s)).not.toThrow()
  })
})
