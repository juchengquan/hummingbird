import { describe, expect, test } from "bun:test"

import { emptyCanvasState, type CanvasState } from "./types"
import {
  placeRelatedNode,
  RELATED_NODE_OFFSET_X,
  RELATED_NODE_STAGGER_Y,
} from "./placement"

function stateWith(...nodes: CanvasState["nodes"]): CanvasState {
  return { ...emptyCanvasState(), nodes }
}

const msg = (id: string, x: number, y: number) => ({
  id,
  kind: "chat-message" as const,
  position: { x, y },
})

describe("placeRelatedNode", () => {
  test("places the new node OFFSET_X to the right at the source's y", () => {
    const state = stateWith(msg("m1", 100, 200))
    const next = placeRelatedNode(state, "m1", { id: "a1", kind: "artifact" })
    const placed = next.nodes.find((n) => n.id === "a1")
    expect(placed).toBeDefined()
    expect(placed!.position).toEqual({ x: 100 + RELATED_NODE_OFFSET_X, y: 200 })
    expect(placed!.kind).toBe("artifact")
  })

  test("no-op when the source node isn't on the canvas", () => {
    const state = stateWith(msg("m1", 0, 0))
    const next = placeRelatedNode(state, "missing", { id: "a1", kind: "artifact" })
    expect(next).toBe(state) // same reference — unchanged
  })

  test("no-op (dedupe) when the new node id is already present", () => {
    const state = stateWith(msg("m1", 0, 0), {
      id: "a1",
      kind: "artifact",
      position: { x: 5, y: 5 },
    })
    const next = placeRelatedNode(state, "m1", { id: "a1", kind: "artifact" })
    expect(next).toBe(state)
  })

  test("connect:true adds an edge source→new; default adds none", () => {
    const state = stateWith(msg("m1", 0, 0))
    const withEdge = placeRelatedNode(
      state,
      "m1",
      { id: "a1", kind: "artifact" },
      { connect: true }
    )
    expect(withEdge.edges).toHaveLength(1)
    expect(withEdge.edges[0]).toMatchObject({ source: "m1", target: "a1" })

    const noEdge = placeRelatedNode(state, "m1", { id: "a2", kind: "artifact" })
    expect(noEdge.edges).toHaveLength(0)
  })

  test("staggers downward when the natural slot is occupied", () => {
    const targetX = 100 + RELATED_NODE_OFFSET_X
    const state = stateWith(
      msg("m1", 100, 200),
      // occupy the natural slot
      { id: "occupant", kind: "note", position: { x: targetX, y: 200 } }
    )
    const next = placeRelatedNode(state, "m1", { id: "a1", kind: "artifact" })
    const placed = next.nodes.find((n) => n.id === "a1")!
    expect(placed.position.x).toBe(targetX)
    expect(placed.position.y).toBe(200 + RELATED_NODE_STAGGER_Y)
  })

  test("two artifacts from the same message fan out without overlap", () => {
    const state = stateWith(msg("m1", 0, 0))
    const s1 = placeRelatedNode(state, "m1", { id: "a1", kind: "artifact" })
    const s2 = placeRelatedNode(s1, "m1", { id: "a2", kind: "artifact" })
    const p1 = s2.nodes.find((n) => n.id === "a1")!.position
    const p2 = s2.nodes.find((n) => n.id === "a2")!.position
    expect(p1).not.toEqual(p2)
    expect(p2.y).toBe(p1.y + RELATED_NODE_STAGGER_Y)
  })

  test("does not mutate the input state", () => {
    const state = stateWith(msg("m1", 0, 0))
    const before = JSON.parse(JSON.stringify(state))
    placeRelatedNode(state, "m1", { id: "a1", kind: "artifact" }, { connect: true })
    expect(state).toEqual(before)
  })
})
