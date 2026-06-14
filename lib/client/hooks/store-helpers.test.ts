import { describe, expect, test } from "bun:test"
import type { Conversation, Message, Prompt } from "@/shared/types"

import {
  clampResourcesSidebarWidth,
  clampSidebarWidth,
  defaultSlug,
  ensureUniquePromptSlug,
  mergeFileSearchConfig,
  mergeImageGenConfig,
  mergeWebFetchConfig,
  mergeWebSearchConfig,
  removeMessage,
  RESOURCES_SIDEBAR_WIDTH_DEFAULT,
  RESOURCES_SIDEBAR_WIDTH_MAX,
  RESOURCES_SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  tombstoneMcpServer,
  updateMessage,
} from "./store-helpers"

describe("clampSidebarWidth", () => {
  test("clamps to MIN when below floor", () => {
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_WIDTH_MIN)
  })
  test("clamps to MAX when above ceiling", () => {
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_WIDTH_MAX)
  })
  test("rounds floats", () => {
    expect(clampSidebarWidth(300.7)).toBe(301)
  })
  test("returns default for NaN", () => {
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
  test("returns default for Infinity", () => {
    expect(clampSidebarWidth(Infinity)).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
})

describe("clampResourcesSidebarWidth", () => {
  test("clamps to its own MIN/MAX", () => {
    expect(clampResourcesSidebarWidth(50)).toBe(RESOURCES_SIDEBAR_WIDTH_MIN)
    expect(clampResourcesSidebarWidth(9999)).toBe(RESOURCES_SIDEBAR_WIDTH_MAX)
  })
  test("returns its own default for NaN", () => {
    expect(clampResourcesSidebarWidth(NaN)).toBe(
      RESOURCES_SIDEBAR_WIDTH_DEFAULT
    )
  })
})

describe("defaultSlug", () => {
  test("lowercases + dasherises punctuation", () => {
    expect(defaultSlug("My Cool Prompt!")).toBe("my-cool-prompt")
  })
  test("trims leading/trailing dashes", () => {
    expect(defaultSlug("---hello---")).toBe("hello")
  })
  test("collapses runs of non-alphanumerics", () => {
    expect(defaultSlug("foo... bar...baz")).toBe("foo-bar-baz")
  })
  test("empty / non-alphanumeric input falls back to 'prompt'", () => {
    expect(defaultSlug("")).toBe("prompt")
    expect(defaultSlug("!!!")).toBe("prompt")
  })
})

function makePrompt(id: string, slug: string, deleted = false): Prompt {
  return {
    id,
    workspaceId: "ws-1",
    name: `Prompt ${id}`,
    slug,
    template: "hi",
    variables: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: deleted ? new Date() : undefined,
  }
}

describe("ensureUniquePromptSlug", () => {
  test("returns base unchanged when no collision", () => {
    expect(ensureUniquePromptSlug("foo", [])).toBe("foo")
  })
  test("appends -2 / -3 on collision", () => {
    const taken = [makePrompt("a", "foo"), makePrompt("b", "foo-2")]
    expect(ensureUniquePromptSlug("foo", taken)).toBe("foo-3")
  })
  test("excludePromptId lets a prompt re-check its own slug without colliding with itself", () => {
    const taken = [makePrompt("a", "foo")]
    expect(ensureUniquePromptSlug("foo", taken, "a")).toBe("foo")
  })
  test("tombstoned prompts don't block their slug", () => {
    const taken = [makePrompt("a", "foo", true)]
    expect(ensureUniquePromptSlug("foo", taken)).toBe("foo")
  })
})

describe("tombstoneMcpServer", () => {
  test("flips enabled to false, sets deletedAt, drops capabilities", () => {
    const before = {
      id: "s",
      workspaceId: "ws-1",
      name: "Github",
      url: "https://mcp.example",
      transport: "http" as const,
      credentialMode: "cloud" as const,
      enabled: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      capabilities: { tools: [], resources: [], prompts: [] },
    }
    const after = tombstoneMcpServer(before)
    expect(after.enabled).toBe(false)
    expect(after.deletedAt).toBeDefined()
    expect(after.capabilities).toBeUndefined()
    // Identity-style fields preserved for orphan UI rendering.
    expect(after.name).toBe("Github")
    expect(after.transport).toBe("http")
  })
})

describe("merge*Config", () => {
  test("mergeWebFetchConfig adds, overrides, and prunes leaves", () => {
    expect(mergeWebFetchConfig(undefined, { maxCalls: 4 })).toEqual({
      maxCalls: 4,
    })
    expect(mergeWebFetchConfig({ maxCalls: 4 }, { maxCalls: 2 })).toEqual({
      maxCalls: 2,
    })
    expect(
      mergeWebFetchConfig({ maxCalls: 4 }, { maxCalls: undefined })
    ).toBeUndefined()
  })

  test("mergeImageGenConfig + mergeFileSearchConfig follow the same pattern", () => {
    expect(
      mergeImageGenConfig(undefined, { maxCalls: 3, aspectRatio: "16:9" })
    ).toEqual({ maxCalls: 3, aspectRatio: "16:9" })
    expect(mergeFileSearchConfig(undefined, { maxCalls: 2 })).toEqual({
      maxCalls: 2,
    })
  })

  test("mergeWebSearchConfig: sub-object deep merge keeps siblings", () => {
    const out = mergeWebSearchConfig(
      {
        maxCalls: 3,
        tavily: { enabled: true, searchDepth: "basic" },
        brave: { enabled: false, freshness: "any" },
      },
      { tavily: { searchDepth: "advanced" } }
    )
    expect(out?.tavily).toEqual({
      enabled: true,
      searchDepth: "advanced",
    })
    // Brave untouched.
    expect(out?.brave).toEqual({ enabled: false, freshness: "any" })
  })

  test("mergeWebSearchConfig: sub-object pruning drops empty providers", () => {
    const out = mergeWebSearchConfig(
      { tavily: { enabled: true, searchDepth: "basic" } },
      { tavily: { enabled: undefined, searchDepth: undefined } }
    )
    // tavily got reduced to {} and pruned; result has no leaves, so undefined.
    expect(out).toBeUndefined()
  })
})

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    role: "user",
    content: "hello",
    timestamp: new Date(),
    ...overrides,
  }
}

type ConversationFixture = Pick<
  Conversation,
  "id" | "title" | "messages" | "createdAt" | "updatedAt" | "pinned"
> &
  Partial<Conversation>

function makeState(conversations: ConversationFixture[]) {
  const full: Conversation[] = conversations.map((c) => ({
    workspaceId: "ws-1",
    systemPrompt: "",
    selectedFileIds: [],
    ...c,
  }))
  return { conversations: full }
}

describe("updateMessage", () => {
  test("patches the message across all conversations", () => {
    const m = makeMessage({ id: "m1", content: "old" })
    const state = makeState([
      { id: "conv-1", title: "C1", messages: [m], createdAt: new Date(), updatedAt: new Date(), pinned: false },
    ])
    const result = updateMessage(state, "m1", (mm) => ({ ...mm, content: "new" }))
    expect(result.conversations?.[0].messages[0].content).toBe("new")
  })

  test("no-op when no message matches → returns {}", () => {
    const state = makeState([
      { id: "conv-1", title: "C1", messages: [makeMessage({ id: "m1" })], createdAt: new Date(), updatedAt: new Date(), pinned: false },
    ])
    expect(updateMessage(state, "m2", (m) => ({ ...m, content: "x" }))).toEqual({})
  })

  test("identity-preserving no-op → returns {}", () => {
    const m = makeMessage({ id: "m1", content: "same" })
    const state = makeState([
      { id: "conv-1", title: "C1", messages: [m], createdAt: new Date(), updatedAt: new Date(), pinned: false },
    ])
    expect(updateMessage(state, "m1", (mm) => mm)).toEqual({})
  })

  test("searches across ALL conversations, not just active", () => {
    const state = makeState([
      { id: "conv-1", title: "C1", messages: [makeMessage({ id: "m1", content: "old" })], createdAt: new Date(), updatedAt: new Date(), pinned: false },
      { id: "conv-2", title: "C2", messages: [makeMessage({ id: "m2", content: "stays" })], createdAt: new Date(), updatedAt: new Date(), pinned: false },
    ])
    const result = updateMessage(state, "m1", (mm) => ({ ...mm, content: "new" }))
    expect(result.conversations?.[0].messages[0].content).toBe("new")
    expect(result.conversations?.[1].messages[0].content).toBe("stays")
  })
})

describe("removeMessage", () => {
  test("removes the message from the owning conversation", () => {
    const state = makeState([
      { id: "conv-1", title: "C1", messages: [makeMessage({ id: "m1" }), makeMessage({ id: "m2" })], createdAt: new Date(), updatedAt: new Date(), pinned: false },
    ])
    const result = removeMessage(state, "m1")
    expect(result.conversations?.[0].messages).toHaveLength(1)
    expect(result.conversations?.[0].messages[0].id).toBe("m2")
  })

  test("no-op when no message matches → returns {}", () => {
    const state = makeState([
      { id: "conv-1", title: "C1", messages: [makeMessage({ id: "m1" })], createdAt: new Date(), updatedAt: new Date(), pinned: false },
    ])
    expect(removeMessage(state, "m2")).toEqual({})
  })

  test("preserves conversation message order", () => {
    const state = makeState([
      { id: "conv-1", title: "C1", messages: [makeMessage({ id: "m1" }), makeMessage({ id: "m2" }), makeMessage({ id: "m3" })], createdAt: new Date(), updatedAt: new Date(), pinned: false },
    ])
    const result = removeMessage(state, "m2")
    expect(result.conversations?.[0].messages.map((mm) => mm.id)).toEqual(["m1", "m3"])
  })
})
