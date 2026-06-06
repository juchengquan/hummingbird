import { describe, expect, test } from "bun:test"

import type { Conversation } from "@/shared/types"

import {
  buildDerivedForkEdges,
  forkEdgeId,
  isForkEdgeId,
} from "./fork-edges"

function makeConv(overrides: Partial<Conversation> & { id: string }): Conversation {
  return {
    workspaceId: "w1",
    title: "Conv",
    messages: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    pinned: false,
    systemPrompt: "",
    selectedFileIds: [],
    ...overrides,
  }
}

const ids = (...xs: string[]) => new Set(xs)

describe("buildDerivedForkEdges", () => {
  test("empty node set → empty", () => {
    expect(buildDerivedForkEdges([], ids())).toEqual([])
  })

  test("root-only conversation → no fork edges", () => {
    const root = makeConv({ id: "root" })
    expect(buildDerivedForkEdges([root], ids("root"))).toEqual([])
  })

  test("fork with both endpoints on canvas → one edge", () => {
    const root = makeConv({ id: "root" })
    const fork = makeConv({
      id: "fork-1",
      parentId: "root",
      forkedFromMessageId: "msg-7",
    })
    const out = buildDerivedForkEdges(
      [root, fork],
      ids("msg-7", "fork-1", "root"),
    )
    expect(out).toEqual([
      {
        id: "fork:fork-1",
        source: "msg-7",
        target: "fork-1",
        label: "fork",
      },
    ])
  })

  test("fork with source-message node missing → edge skipped", () => {
    const fork = makeConv({
      id: "fork-1",
      parentId: "root",
      forkedFromMessageId: "msg-not-on-canvas",
    })
    expect(buildDerivedForkEdges([fork], ids("fork-1"))).toEqual([])
  })

  test("fork with conversation node missing → edge skipped", () => {
    const fork = makeConv({
      id: "fork-1",
      parentId: "root",
      forkedFromMessageId: "msg-7",
    })
    expect(buildDerivedForkEdges([fork], ids("msg-7"))).toEqual([])
  })

  test("multi-level fork chain — each generation contributes its own edge", () => {
    const root = makeConv({ id: "root" })
    const child = makeConv({
      id: "child",
      parentId: "root",
      forkedFromMessageId: "msg-7",
    })
    const grandchild = makeConv({
      id: "grandchild",
      parentId: "child",
      forkedFromMessageId: "msg-22",
    })
    const out = buildDerivedForkEdges(
      [root, child, grandchild],
      ids("msg-7", "msg-22", "child", "grandchild", "root"),
    )
    expect(out.map((e) => e.target).sort()).toEqual(["child", "grandchild"])
  })

  test("ignores conversations missing parentId or forkedFromMessageId (defensively)", () => {
    const partial = makeConv({
      id: "c-incomplete",
      parentId: "root",
      // forkedFromMessageId omitted
    })
    const out = buildDerivedForkEdges(
      [partial],
      ids("c-incomplete", "root"),
    )
    expect(out).toEqual([])
  })

  test("source and target match the design pin — source is the message, target is the conversation node", () => {
    const fork = makeConv({
      id: "fork-1",
      parentId: "root",
      forkedFromMessageId: "msg-7",
    })
    const out = buildDerivedForkEdges([fork], ids("msg-7", "fork-1"))
    expect(out[0].source).toBe("msg-7")
    expect(out[0].target).toBe("fork-1")
  })
})

describe("forkEdgeId + isForkEdgeId", () => {
  test("forkEdgeId uses the `fork:` prefix", () => {
    expect(forkEdgeId("abc")).toBe("fork:abc")
  })

  test("isForkEdgeId recognises generated ids", () => {
    expect(isForkEdgeId(forkEdgeId("any"))).toBe(true)
  })

  test("isForkEdgeId rejects stored edge ids (uuid shape, no colon)", () => {
    // Stored edges use uuids — no colon prefix possible.
    expect(isForkEdgeId("e1234abc-edge")).toBe(false)
    expect(isForkEdgeId("")).toBe(false)
  })
})
