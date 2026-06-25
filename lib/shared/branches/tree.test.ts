import { describe, expect, it } from "bun:test"

import type { Conversation, Message } from "@/shared/types"
import {
  buildTree,
  countNodes,
  describeBranchPoint,
  findRoot,
} from "./tree"

function conv(partial: Partial<Conversation> & { id: string }): Conversation {
  return {
    workspaceId: "w1",
    title: partial.id,
    messages: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    pinned: false,
    systemPrompt: "",
    selectedFileIds: [],
    ...partial,
  }
}

function msg(id: string, content: string): Message {
  return { id, role: "user", content, timestamp: new Date("2026-01-01T00:00:00Z") }
}

describe("findRoot", () => {
  it("walks up parentId to the topmost ancestor", () => {
    const a = conv({ id: "a" })
    const b = conv({ id: "b", parentId: "a" })
    const c = conv({ id: "c", parentId: "b" })
    expect(findRoot([a, b, c], "c")?.id).toBe("a")
  })
  it("returns the node itself when it has no parent", () => {
    const a = conv({ id: "a" })
    expect(findRoot([a], "a")?.id).toBe("a")
  })
  it("falls back to the current node on broken lineage (missing parent)", () => {
    const b = conv({ id: "b", parentId: "gone" })
    expect(findRoot([b], "b")?.id).toBe("b")
  })
  it("returns null when the start id isn't present", () => {
    expect(findRoot([], "x")).toBeNull()
  })
})

describe("buildTree", () => {
  it("nests descendants and assigns depth", () => {
    const a = conv({ id: "a" })
    const b = conv({ id: "b", parentId: "a" })
    const tree = buildTree([a, b], "a")
    expect(tree?.depth).toBe(0)
    expect(tree?.children).toHaveLength(1)
    expect(tree?.children[0].conversation.id).toBe("b")
    expect(tree?.children[0].depth).toBe(1)
  })
  it("sorts children by createdAt ascending", () => {
    const a = conv({ id: "a" })
    const late = conv({ id: "late", parentId: "a", createdAt: new Date("2026-03-01T00:00:00Z") })
    const early = conv({ id: "early", parentId: "a", createdAt: new Date("2026-02-01T00:00:00Z") })
    const tree = buildTree([a, late, early], "a")
    expect(tree?.children.map((c) => c.conversation.id)).toEqual(["early", "late"])
  })
  it("returns null for a missing root", () => {
    expect(buildTree([], "nope")).toBeNull()
  })
})

describe("countNodes", () => {
  it("counts the whole tree", () => {
    const a = conv({ id: "a" })
    const b = conv({ id: "b", parentId: "a" })
    const cc = conv({ id: "c", parentId: "a" })
    const tree = buildTree([a, b, cc], "a")!
    expect(countNodes(tree)).toBe(3)
  })
})

describe("describeBranchPoint", () => {
  it("returns the first-line snippet of the branch-point message", () => {
    const parent = conv({ id: "p", messages: [msg("m1", "hello world\nsecond line")] })
    expect(describeBranchPoint(parent, "m1")).toBe("hello world")
  })
  it("truncates a long snippet to 58 chars with an ellipsis", () => {
    const long = "x".repeat(80)
    const parent = conv({ id: "p", messages: [msg("m1", long)] })
    const out = describeBranchPoint(parent, "m1")!
    expect(out.length).toBe(58)
    expect(out.endsWith("…")).toBe(true)
  })
  it("returns null for an undefined id or a missing message", () => {
    const parent = conv({ id: "p", messages: [msg("m1", "hi")] })
    expect(describeBranchPoint(parent, undefined)).toBeNull()
    expect(describeBranchPoint(parent, "gone")).toBeNull()
  })
})
