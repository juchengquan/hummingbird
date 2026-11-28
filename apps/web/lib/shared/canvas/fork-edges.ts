/**
 * Flowchat canvas — derived fork edges.
 *
 * Fork relationships are *data*, not canvas state — they live on the
 * conversation row (`parentId` + `forkedFromMessageId`). Rather than
 * persist them into `canvasState.edges` (where the user could hand-
 * draw fake fork edges or accidentally delete real ones), we compute
 * a synthetic edge list at render time and merge it into React Flow's
 * `edges` prop. The merge is shallow: the user's stored decoration
 * edges keep their existing renderer; these synthetic edges render
 * with a distinct style and are pinned non-editable / non-selectable
 * by the React Flow config at the call site.
 *
 * Pure helper — no React, no store, takes the workspace's
 * conversation list + the canvas-state snapshot, returns a freshly
 * shaped edge list. See `docs/_done/PLAN-flowchat-canvas.md` for the
 * design pins.
 */

import type { Conversation } from "@/shared/types"

import type { CanvasEdge } from "./types"

/**
 * One render-only fork edge. Shape mirrors `CanvasEdge` so React Flow
 * sees the same interface as a stored edge — but the id pattern
 * (`fork:<conversationId>`) lets the renderer style and lock these
 * separately.
 */
export type DerivedForkEdge = CanvasEdge

/** Build the synthetic edge list for the active workspace. Returns
 *  an empty array when no fork pairs land on the canvas; the caller
 *  can spread it into the React Flow edges prop unconditionally.
 *
 *  An edge is emitted only when **both** endpoints are currently on
 *  the canvas — the source-message node (keyed by
 *  `forkedFromMessageId`) and the conversation node (keyed by the
 *  fork's `id`). If either side has been removed from the canvas
 *  (user deleted the node, or a prune pass stripped a dangling
 *  reference), the edge silently no-ops. Same defensive shape as
 *  `parseCanvasState`'s edge-endpoint check.
 *
 *  The conversations argument is the **workspace-scoped** list — the
 *  caller filters before passing it in. `nodeIdsOnCanvas` is the live
 *  set of React Flow node ids; the caller builds it cheaply from the
 *  current node array. We accept the Set rather than a CanvasState
 *  so the helper composes cleanly with either persisted state OR
 *  React Flow's live in-memory snapshot.
 */
export function buildDerivedForkEdges(
  conversations: readonly Conversation[],
  nodeIdsOnCanvas: ReadonlySet<string>,
): DerivedForkEdge[] {
  if (nodeIdsOnCanvas.size === 0) return []

  const out: DerivedForkEdge[] = []
  for (const conv of conversations) {
    if (!conv.parentId || !conv.forkedFromMessageId) continue
    if (!nodeIdsOnCanvas.has(conv.forkedFromMessageId)) continue
    if (!nodeIdsOnCanvas.has(conv.id)) continue
    out.push({
      id: forkEdgeId(conv.id),
      source: conv.forkedFromMessageId,
      target: conv.id,
      label: "fork",
    })
  }
  return out
}

/** Stable id pattern for synthetic fork edges. The `fork:` prefix is
 *  reserved — stored edges can't collide because the canvas always
 *  generates their ids via `uuid()` (no colons). Lets the renderer
 *  branch on `id.startsWith("fork:")` to apply the synthetic style. */
export function forkEdgeId(conversationId: string): string {
  return `fork:${conversationId}`
}

/** True iff the edge id was produced by `forkEdgeId`. Useful at the
 *  React Flow callback boundary — the panel can ignore delete /
 *  selection events that target a synthetic edge. */
export function isForkEdgeId(id: string): boolean {
  return id.startsWith("fork:")
}
