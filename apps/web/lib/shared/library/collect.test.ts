import { describe, expect, test } from "bun:test"

import type { Artifact, Conversation, GeneratedImage, Message } from "@/shared/types"

import { collectWorkspaceLibraryItems } from "./collect"

function img(id: string, prompt = ""): GeneratedImage {
  return {
    id,
    url: `https://example.com/${id}.png`,
    width: 1024,
    height: 1024,
    format: "png",
    prompt,
    mode: "t2i",
  }
}

function msg(
  id: string,
  timestamp: string,
  images?: GeneratedImage[],
): Message {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp: new Date(timestamp),
    ...(images ? { generatedImages: images } : {}),
  }
}

function conv(
  id: string,
  workspaceId: string,
  title: string,
  messages: Message[] = [],
): Conversation {
  return {
    id,
    workspaceId,
    title,
    messages,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    pinned: false,
    systemPrompt: "",
    selectedFileIds: [],
  }
}

function artifact(
  id: string,
  workspaceId: string,
  conversationId: string | null,
  createdAt: string,
  title = `Artifact ${id}`,
): Artifact {
  return {
    id,
    workspaceId,
    conversationId,
    messageId: null,
    kind: "code",
    language: "tsx",
    title,
    content: "",
    storagePath: null,
    pinned: false,
    createdAt: new Date(createdAt),
  }
}

describe("collectWorkspaceLibraryItems", () => {
  test("empty workspace → empty list", () => {
    expect(collectWorkspaceLibraryItems("w1", [], [])).toEqual([])
  })

  test("skips conversations belonging to other workspaces", () => {
    const wrongWs = conv("c-other", "w-OTHER", "Other ws", [
      msg("m1", "2026-01-01", [img("i1")]),
    ])
    const items = collectWorkspaceLibraryItems("w1", [wrongWs], [])
    expect(items).toEqual([])
  })

  test("collects images from all messages in the active workspace", () => {
    const c1 = conv("c1", "w1", "Q4 planning", [
      msg("m-no-img", "2026-01-01"),
      msg("m1", "2026-01-02", [img("i1", "first"), img("i2", "second")]),
    ])
    const c2 = conv("c2", "w1", "", [
      msg("m2", "2026-01-03", [img("i3", "third")]),
    ])
    const items = collectWorkspaceLibraryItems("w1", [c1, c2], [])

    expect(items).toHaveLength(3)
    // Newest first by message timestamp.
    expect(items[0].kind).toBe("image")
    if (items[0].kind === "image") {
      expect(items[0].image.id).toBe("i3")
      // Empty-title conversations get the "Untitled" fallback so the
      // panel never renders a blank breadcrumb.
      expect(items[0].conversationTitle).toBe("Untitled")
    }
    // Items 1 and 2 share a timestamp (both on m1, 2026-01-02). Stable
    // sort preserves push order — i1 was pushed first, so i1 is at [1],
    // i2 at [2]. Both carry the conversation title.
    if (items[1].kind === "image") {
      expect(items[1].image.id).toBe("i1")
      expect(items[1].conversationTitle).toBe("Q4 planning")
    }
    if (items[2].kind === "image") {
      expect(items[2].image.id).toBe("i2")
      expect(items[2].conversationTitle).toBe("Q4 planning")
    }
  })

  test("collects workspace artifacts including orphans whose conversation is gone", () => {
    const c1 = conv("c1", "w1", "Live conversation", [])
    const stillLinked = artifact("a1", "w1", "c1", "2026-01-02")
    const orphaned = artifact("a2", "w1", "c-deleted", "2026-01-03")
    const truncatedConv = artifact("a3", "w1", null, "2026-01-04")

    const items = collectWorkspaceLibraryItems("w1", [c1], [
      stillLinked,
      orphaned,
      truncatedConv,
    ])
    expect(items).toHaveLength(3)
    // All three should show — orphans don't get dropped (the panel
    // renders them as a static "(conversation removed)" row), they just
    // can't resolve a real title.
    const byId = new Map(
      items
        .filter((it): it is Extract<typeof it, { kind: "artifact" }> => it.kind === "artifact")
        .map((it) => [it.artifact.id, it]),
    )
    expect(byId.get("a1")?.conversationTitle).toBe("Live conversation")
    expect(byId.get("a2")?.conversationTitle).toBe("Untitled")
    expect(byId.get("a3")?.conversationTitle).toBe("Untitled")
  })

  test("interleaves images + artifacts by timestamp, newest first", () => {
    const c1 = conv("c1", "w1", "Thread", [
      msg("m1", "2026-01-02T10:00:00Z", [img("i1", "early image")]),
      msg("m2", "2026-01-04T10:00:00Z", [img("i2", "late image")]),
    ])
    const a1 = artifact("a1", "w1", "c1", "2026-01-01T10:00:00Z")
    const a2 = artifact("a2", "w1", "c1", "2026-01-03T10:00:00Z")
    const items = collectWorkspaceLibraryItems("w1", [c1], [a1, a2])

    const order = items.map((it) =>
      it.kind === "image" ? `img:${it.image.id}` : `art:${it.artifact.id}`,
    )
    expect(order).toEqual(["img:i2", "art:a2", "img:i1", "art:a1"])
  })

  test("artifacts from other workspaces are skipped (no leak across workspaces)", () => {
    const c1 = conv("c1", "w1", "Mine", [])
    const myArt = artifact("a1", "w1", "c1", "2026-01-01")
    const otherArt = artifact("a2", "w-OTHER", "c1", "2026-01-02")
    const items = collectWorkspaceLibraryItems("w1", [c1], [myArt, otherArt])
    expect(items).toHaveLength(1)
    if (items[0].kind === "artifact") {
      expect(items[0].artifact.id).toBe("a1")
    }
  })

  test("artifacts can still surface even when the workspace has zero conversations", () => {
    // Edge case: user deletes the source conversation but the artifact
    // stays. With no conversations to filter against, the artifact pass
    // still has to run — but the title lookup returns "Untitled" for
    // any conversationId (the empty Map has no hits).
    const a = artifact("a1", "w1", "c-deleted", "2026-01-01")
    const items = collectWorkspaceLibraryItems("w1", [], [a])
    expect(items).toHaveLength(1)
    if (items[0].kind === "artifact") {
      expect(items[0].conversationTitle).toBe("Untitled")
    }
  })
})
