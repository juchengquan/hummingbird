import { describe, expect, test } from "bun:test"

import { parseCanvasState } from "./types"

describe("parseCanvasState — node kinds", () => {
  test("round-trips every supported kind", () => {
    const input = {
      nodes: [
        { id: "m1", kind: "chat-message", position: { x: 0, y: 0 } },
        { id: "a1", kind: "artifact", position: { x: 1, y: 0 } },
        { id: "n1", kind: "note", position: { x: 2, y: 0 } },
        { id: "f1", kind: "file", position: { x: 3, y: 0 } },
        { id: "b1", kind: "url-bookmark", position: { x: 4, y: 0 } },
        { id: "s1", kind: "sticky", position: { x: 5, y: 0 }, content: "hi" },
        { id: "c1", kind: "conversation", position: { x: 6, y: 0 } },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }
    const out = parseCanvasState(input)
    expect(out).not.toBeNull()
    expect(out!.nodes.map((n) => n.kind)).toEqual([
      "chat-message",
      "artifact",
      "note",
      "file",
      "url-bookmark",
      "sticky",
      "conversation",
    ])
  })

  test("drops nodes with an unknown kind without poisoning the rest", () => {
    const out = parseCanvasState({
      nodes: [
        { id: "good", kind: "conversation", position: { x: 0, y: 0 } },
        { id: "bad", kind: "not-a-kind", position: { x: 1, y: 0 } },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    expect(out).not.toBeNull()
    expect(out!.nodes.map((n) => n.id)).toEqual(["good"])
  })

  test("conversation node ignores stray `content` (sticky-only field)", () => {
    const out = parseCanvasState({
      nodes: [
        {
          id: "c1",
          kind: "conversation",
          position: { x: 0, y: 0 },
          content: "should-not-survive",
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    expect(out!.nodes[0].content).toBeUndefined()
  })
})

describe("parseCanvasState — robustness boundary already covered by code", () => {
  test("returns null on non-object input", () => {
    expect(parseCanvasState(null)).toBeNull()
    expect(parseCanvasState("oops")).toBeNull()
    expect(parseCanvasState([])).toBeNull()
  })

  test("returns empty canvas state when the object has no nodes/edges", () => {
    const out = parseCanvasState({})
    expect(out).not.toBeNull()
    expect(out!.nodes).toEqual([])
    expect(out!.edges).toEqual([])
  })

  test("drops edges whose endpoints aren't on the canvas", () => {
    const out = parseCanvasState({
      nodes: [{ id: "c1", kind: "conversation", position: { x: 0, y: 0 } }],
      edges: [
        { id: "e-good", source: "c1", target: "c1" },
        { id: "e-bad", source: "c1", target: "ghost" },
      ],
    })
    expect(out!.edges.map((e) => e.id)).toEqual(["e-good"])
  })
})
