/**
 * Workspace canvas — the persisted spatial layout for a workspace.
 *
 * A canvas is a *view* of content that already exists elsewhere in the
 * store (chat messages, artifacts, notes, files, url-bookmarks). The
 * only canvas-owned state is **position + connections** — node bodies
 * are projected from the live domain objects at render time, keyed by
 * the underlying row id. The one exception is `sticky` nodes, which
 * are free-form text with no backing row, so they carry their own
 * `content`.
 *
 * Stored as `canvas_state jsonb` on the workspaces row (see migration
 * 0015) and round-tripped through the sync layer as a single opaque
 * field (whole-object replace on change — the JSON is KBs).
 *
 * Pure module: no React, no I/O. Lives in `lib/shared` so both the
 * client canvas panel and the sync codec can import it.
 */

export type CanvasNodeKind =
  | "chat-message"
  | "artifact"
  | "note"
  | "file"
  | "url-bookmark"
  | "sticky"

/** All non-sticky kinds project from a backing store row by id. */
export const PROJECTED_NODE_KINDS: readonly CanvasNodeKind[] = [
  "chat-message",
  "artifact",
  "note",
  "file",
  "url-bookmark",
]

export interface CanvasNodePosition {
  x: number
  y: number
}

export interface CanvasNode {
  /** For projected kinds, matches the underlying row id (message /
   *  artifact / note / file / bookmark). For `sticky`, a standalone
   *  generated id. Unique within a canvas (React Flow requires it),
   *  which also means a given object appears at most once. */
  id: string
  kind: CanvasNodeKind
  position: CanvasNodePosition
  /** Persisted node box size when the user has resized it. */
  width?: number
  height?: number
  /** `sticky` nodes only — the free-form note text. Ignored for
   *  projected kinds (their body comes from the live row). */
  content?: string
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  label?: string
}

export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface CanvasState {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport: CanvasViewport
}

export const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 }

export function emptyCanvasState(): CanvasState {
  return { nodes: [], edges: [], viewport: { ...DEFAULT_VIEWPORT } }
}

const VALID_KINDS = new Set<string>([
  "chat-message",
  "artifact",
  "note",
  "file",
  "url-bookmark",
  "sticky",
])

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

/**
 * Boundary parser for `workspaces.canvas_state`. Returns a normalised
 * `CanvasState` from arbitrary JSON, dropping any malformed node / edge
 * rather than throwing — a corrupted or hand-edited row shouldn't blank
 * the whole canvas (same defensiveness as `parseGeneratedImages` in
 * reconcile.ts). Returns `null` only when the top-level value isn't an
 * object at all, so callers can distinguish "no canvas" from "empty
 * canvas".
 */
export function parseCanvasState(value: unknown): CanvasState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const v = value as Record<string, unknown>

  const nodes: CanvasNode[] = []
  const seenNodeIds = new Set<string>()
  if (Array.isArray(v.nodes)) {
    for (const raw of v.nodes) {
      if (!raw || typeof raw !== "object") continue
      const n = raw as Record<string, unknown>
      if (typeof n.id !== "string" || !n.id) continue
      if (typeof n.kind !== "string" || !VALID_KINDS.has(n.kind)) continue
      const pos = n.position as Record<string, unknown> | undefined
      if (!pos || !isFiniteNumber(pos.x) || !isFiniteNumber(pos.y)) continue
      if (seenNodeIds.has(n.id)) continue // de-dup defensively
      seenNodeIds.add(n.id)
      const node: CanvasNode = {
        id: n.id,
        kind: n.kind as CanvasNodeKind,
        position: { x: pos.x, y: pos.y },
      }
      if (isFiniteNumber(n.width)) node.width = n.width
      if (isFiniteNumber(n.height)) node.height = n.height
      if (n.kind === "sticky" && typeof n.content === "string") {
        node.content = n.content
      }
      nodes.push(node)
    }
  }

  const edges: CanvasEdge[] = []
  const seenEdgeIds = new Set<string>()
  if (Array.isArray(v.edges)) {
    for (const raw of v.edges) {
      if (!raw || typeof raw !== "object") continue
      const e = raw as Record<string, unknown>
      if (typeof e.id !== "string" || !e.id) continue
      if (typeof e.source !== "string" || typeof e.target !== "string") continue
      // Drop edges referencing nodes we dropped — keeps the graph valid.
      if (!seenNodeIds.has(e.source) || !seenNodeIds.has(e.target)) continue
      if (seenEdgeIds.has(e.id)) continue
      seenEdgeIds.add(e.id)
      const edge: CanvasEdge = { id: e.id, source: e.source, target: e.target }
      if (typeof e.label === "string") edge.label = e.label
      edges.push(edge)
    }
  }

  const vp = v.viewport as Record<string, unknown> | undefined
  const viewport: CanvasViewport =
    vp && isFiniteNumber(vp.x) && isFiniteNumber(vp.y) && isFiniteNumber(vp.zoom)
      ? { x: vp.x, y: vp.y, zoom: vp.zoom }
      : { ...DEFAULT_VIEWPORT }

  return { nodes, edges, viewport }
}

/** True when the canvas has no nodes (edges can't exist without nodes). */
export function isCanvasEmpty(state: CanvasState | null | undefined): boolean {
  return !state || state.nodes.length === 0
}
