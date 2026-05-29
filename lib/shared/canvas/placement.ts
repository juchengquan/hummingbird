/**
 * Auto-placement for canvas nodes spawned from a related object
 * (Phase 4 of the workspace-canvas plan).
 *
 * When an artifact is created from a chat message and that message is
 * already a node on the workspace canvas, we drop the new artifact node
 * just to the right of its source and draw a connecting edge — capturing
 * the "this artifact was generated from that message" relationship
 * without the user hand-placing it. Pure + deterministic so it's unit
 * testable and safe to call from the store.
 */

import type { CanvasNode, CanvasNodeKind, CanvasState } from "./types"

/** Horizontal gap from the source node's origin to the new node's
 *  origin. Source cards are ~220px wide, so 280 clears them with a
 *  comfortable gutter. */
export const RELATED_NODE_OFFSET_X = 280
/** Vertical step used to stagger when the target slot is occupied. */
export const RELATED_NODE_STAGGER_Y = 90
/** Manhattan radius below which two node origins are "the same slot". */
const SLOT_EPSILON = 40
const MAX_STAGGER = 12

function slotTaken(nodes: CanvasNode[], x: number, y: number): boolean {
  return nodes.some(
    (n) =>
      Math.abs(n.position.x - x) < SLOT_EPSILON &&
      Math.abs(n.position.y - y) < SLOT_EPSILON
  )
}

/**
 * Returns a new CanvasState with `newNode` placed beside the node
 * identified by `sourceId`, optionally connected by an edge.
 *
 * No-ops (returns the input unchanged) when:
 *   - the source node isn't on the canvas (nothing to anchor to), or
 *   - a node with `newNode.id` is already present (dedupe).
 *
 * When the natural slot (source.x + OFFSET, source.y) is occupied, the
 * new node staggers downward until it finds free space, so a message
 * with several generated artifacts fans them out instead of stacking.
 */
export function placeRelatedNode(
  state: CanvasState,
  sourceId: string,
  newNode: { id: string; kind: CanvasNodeKind },
  opts: { connect?: boolean } = {}
): CanvasState {
  const source = state.nodes.find((n) => n.id === sourceId)
  if (!source) return state
  if (state.nodes.some((n) => n.id === newNode.id)) return state

  const x = source.position.x + RELATED_NODE_OFFSET_X
  let y = source.position.y
  for (let i = 0; i < MAX_STAGGER && slotTaken(state.nodes, x, y); i++) {
    y += RELATED_NODE_STAGGER_Y
  }

  const node: CanvasNode = {
    id: newNode.id,
    kind: newNode.kind,
    position: { x, y },
  }

  const edges = opts.connect
    ? [
        ...state.edges,
        {
          id: `e-${sourceId}-${newNode.id}`,
          source: sourceId,
          target: newNode.id,
        },
      ]
    : state.edges

  return { ...state, nodes: [...state.nodes, node], edges }
}
