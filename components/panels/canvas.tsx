"use client"

import "@xyflow/react/dist/style.css"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  addEdge,
  Background,
  Controls,
  getNodesBounds,
  getViewportForBounds,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react"
import { toPng } from "html-to-image"
import { Download, Grid2x2, Grid2x2Check } from "lucide-react"
import { toast } from "sonner"

import { useStore, useActiveWorkspace } from "@/client/hooks/use-store"
import { uuid } from "@/shared/uuid"
import { Button } from "@/components/ui/button"
import {
  emptyCanvasState,
  type CanvasNodeKind,
  type CanvasState,
} from "@/shared/canvas/types"
import {
  buildDerivedForkEdges,
  isForkEdgeId,
} from "@/shared/canvas/fork-edges"
import { canvasNodeTypes, type CanvasNodeData } from "@/components/canvas/canvas-nodes"
import { EditableEdge, type EditableEdgeData } from "@/components/canvas/canvas-edge"
import {
  CanvasToolbar,
  type AddableGroups,
  type AddableItem,
} from "@/components/canvas/canvas-toolbar"

type RfNode = Node<CanvasNodeData>

const PERSIST_DEBOUNCE_MS = 450
/** Grid step for snap-to-grid + keyboard nudge. */
const GRID = 16
/** Module-const so the object identity is stable across renders (React
 *  Flow warns when edgeTypes/nodeTypes change identity each render). */
const canvasEdgeTypes = { editable: EditableEdge }
/** How many recent messages the add-picker offers (flattening every
 *  conversation's history would be unbounded). */
const MESSAGE_PICKER_LIMIT = 40

function snippet(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

// --- store CanvasState ⇄ React Flow conversions -----------------------------

function buildRfState(state: CanvasState): { nodes: RfNode[]; edges: Edge[] } {
  const nodes: RfNode[] = state.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: n.position,
    data:
      n.kind === "sticky"
        ? { kind: "sticky", content: n.content ?? "" }
        : { kind: n.kind },
    ...(n.width ? { width: n.width } : {}),
    ...(n.height ? { height: n.height } : {}),
  }))
  const edges: Edge[] = state.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    ...(e.label ? { label: e.label } : {}),
  }))
  return { nodes, edges }
}

function toCanvasState(
  nodes: RfNode[],
  edges: Edge[],
  viewport: { x: number; y: number; zoom: number }
): CanvasState {
  return {
    nodes: nodes.map((n) => {
      const data = n.data as CanvasNodeData
      const kind = (n.type ?? "sticky") as CanvasNodeKind
      return {
        id: n.id,
        kind,
        position: { x: n.position.x, y: n.position.y },
        ...(typeof n.width === "number" ? { width: n.width } : {}),
        ...(typeof n.height === "number" ? { height: n.height } : {}),
        ...(kind === "sticky" && typeof data.content === "string"
          ? { content: data.content }
          : {}),
      }
    }),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(typeof e.label === "string" && e.label ? { label: e.label } : {}),
    })),
    viewport,
  }
}

// --- inner canvas (inside ReactFlowProvider) --------------------------------

function CanvasInner({ workspaceId }: { workspaceId: string }) {
  const setWorkspaceCanvasState = useStore((s) => s.setWorkspaceCanvasState)
  const rf = useReactFlow()
  const wrapperRef = useRef<HTMLDivElement>(null)

  const [nodes, setNodes, onNodesChange] = useNodesState<RfNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  // Edge currently in inline-label-edit mode (set by double-click).
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null)
  // Snap-to-grid toggle (session-local, not persisted).
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Live workspace collections for the add-picker + dead-ref pruning.
  // (The node renderers read their own bodies; these drive what's
  // *addable* and which projected nodes still have a backing row.)
  const conversations = useStore((s) => s.conversations)
  const artifacts = useStore((s) => s.artifacts)
  const notes = useStore((s) => s.notes)
  const files = useStore((s) => s.files)
  const resources = useStore((s) => s.resources)
  const urlBookmarks = useStore((s) => s.urlBookmarks)

  // --- persistence ----------------------------------------------------------
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest RF state kept in a ref so the unmount flush sees current data
  // without re-subscribing the effect.
  const latest = useRef<{ nodes: RfNode[]; edges: Edge[] }>({ nodes: [], edges: [] })
  latest.current = { nodes, edges }

  const persistNow = useCallback(() => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
    const vp = rf.getViewport()
    const next = toCanvasState(latest.current.nodes, latest.current.edges, vp)
    setWorkspaceCanvasState(workspaceId, next)
  }, [rf, setWorkspaceCanvasState, workspaceId])

  const persistDebounced = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(persistNow, PERSIST_DEBOUNCE_MS)
  }, [persistNow])

  // --- seed on workspace switch ---------------------------------------------
  // Keyed on workspaceId only (NOT the workspace object) so persisting
  // canvas_state back doesn't re-seed and clobber an in-progress drag.
  // Reads the canvas + existence sets from getState() at seed time and
  // prunes nodes whose backing row is gone.
  useEffect(() => {
    const state = useStore.getState()
    const ws = state.workspaces.find((w) => w.id === workspaceId)
    const canvas = ws?.canvasState ?? emptyCanvasState()

    const liveFileIds = new Set(
      state.resources
        .filter((r) => r.workspaceId === workspaceId)
        .map((r) => r.fileId)
    )
    const exists = (kind: CanvasNodeKind, id: string): boolean => {
      switch (kind) {
        case "sticky":
          return true
        case "chat-message":
          return state.conversations.some((c) =>
            c.messages.some((m) => m.id === id)
          )
        case "artifact":
          return state.artifacts.some((a) => a.id === id)
        case "note":
          return state.notes.some((n) => n.id === id)
        case "file":
          return liveFileIds.has(id) && state.files.some((f) => f.id === id && !f.deletedAt)
        case "url-bookmark":
          return state.urlBookmarks.some((b) => b.id === id && !b.deletedAt)
        case "conversation":
          // Same shape as the other projected kinds: a node only
          // survives the prune pass while its underlying row is alive.
          // Sidebar-side deletion → canvas node disappears on the next
          // re-seed. Workspace scope is enforced by the outer canvas
          // filter, so no need to re-check workspaceId here.
          return state.conversations.some((c) => c.id === id)
      }
    }
    const pruned: CanvasState = {
      nodes: canvas.nodes.filter((n) => exists(n.kind, n.id)),
      edges: canvas.edges,
      viewport: canvas.viewport,
    }
    // Drop edges whose endpoints were pruned.
    const keptIds = new Set(pruned.nodes.map((n) => n.id))
    pruned.edges = pruned.edges.filter(
      (e) => keptIds.has(e.source) && keptIds.has(e.target)
    )

    const { nodes: seedNodes, edges: seedEdges } = buildRfState(pruned)
    setNodes(seedNodes)
    setEdges(seedEdges)
    // Restore viewport after the instance paints.
    requestAnimationFrame(() => rf.setViewport(pruned.viewport))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // Flush any pending debounced write when leaving the workspace / unmounting.
  useEffect(() => {
    return () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
        persistTimer.current = null
        // Synchronous final write so navigating away doesn't drop the
        // last drag.
        const vp = rf.getViewport()
        setWorkspaceCanvasState(
          workspaceId,
          toCanvasState(latest.current.nodes, latest.current.edges, vp)
        )
      }
    }
  }, [rf, setWorkspaceCanvasState, workspaceId])

  // --- sticky editing -------------------------------------------------------
  const handleStickyChange = useCallback(
    (id: string, content: string) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, content } } : n
        )
      )
      persistDebounced()
    },
    [setNodes, persistDebounced]
  )

  // Inject the sticky onChange callback into node data. Done here (not in
  // buildRfState) so the callback identity is stable across re-seeds.
  const nodesWithHandlers = useMemo(
    () =>
      nodes.map((n) =>
        n.data.kind === "sticky"
          ? {
              ...n,
              data: {
                ...n.data,
                onStickyChange: (c: string) => handleStickyChange(n.id, c),
              },
            }
          : n
      ),
    [nodes, handleStickyChange]
  )

  // --- interactions ---------------------------------------------------------
  const onConnect = useCallback(
    (conn: Connection) => {
      setEdges((eds) => addEdge({ ...conn, id: uuid() }, eds))
      persistNow()
    },
    [setEdges, persistNow]
  )

  // Inline edge-label editing (Phase 5). Double-click an edge → its
  // midpoint input opens; commit writes the label + persists.
  const onEdgeDoubleClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => setEditingEdgeId(edge.id),
    []
  )
  const onCommitEdgeLabel = useCallback(
    (edgeId: string, label: string) => {
      setEdges((eds) =>
        eds.map((e) =>
          e.id === edgeId ? { ...e, label: label || undefined } : e
        )
      )
      setEditingEdgeId(null)
      persistNow()
    },
    [setEdges, persistNow]
  )
  const onStartEditEdge = useCallback(
    (edgeId: string) => setEditingEdgeId(edgeId),
    []
  )

  // Guard `onEdgesChange` so React Flow's bulk operations (select all
  // → delete, "delete selected" keyboard shortcut, programmatic
  // changes) can't touch synthetic fork edges. Each change carries an
  // edge `id`; the `fork:` prefix marks the synthetics. Stored-edge
  // changes flow through to the underlying setter unchanged.
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      const filtered = changes.filter((c) => {
        if ("id" in c && typeof c.id === "string" && isForkEdgeId(c.id)) {
          return false
        }
        return true
      })
      if (filtered.length === 0) return
      onEdgesChange(filtered)
    },
    [onEdgesChange],
  )

  // Flowchat — synthetic fork edges derived at render time from
  // `parentId` + `forkedFromMessageId` on each conversation in this
  // workspace, NOT persisted to `canvasState.edges`. Recomputed when
  // the conversation list or the live node set changes. These render
  // distinct from user-drawn edges and can't be deleted by the user
  // (see `onEdgesChange` filter below).
  const nodeIdsOnCanvas = useMemo(
    () => new Set(nodes.map((n) => n.id)),
    [nodes],
  )
  const wsConversations = useMemo(
    () => conversations.filter((c) => c.workspaceId === workspaceId),
    [conversations, workspaceId],
  )
  const derivedForkEdges = useMemo(
    () => buildDerivedForkEdges(wsConversations, nodeIdsOnCanvas),
    [wsConversations, nodeIdsOnCanvas],
  )

  // Thread the editing id + callbacks into every edge's data, and force
  // the editable edge type. Mirrors the sticky-node handler injection.
  // Synthetic fork edges ride on the same React Flow edge prop but
  // skip the editor wiring — they're not user-editable and the
  // `editable` renderer would otherwise let a double-click open a
  // label editor for them.
  const edgesWithHandlers = useMemo<Edge[]>(
    () => [
      ...edges.map((e) => ({
        ...e,
        type: "editable",
        data: {
          ...(e.data ?? {}),
          editingEdgeId,
          onStartEdit: onStartEditEdge,
          onCommitLabel: onCommitEdgeLabel,
        } satisfies EditableEdgeData,
      })),
      ...derivedForkEdges.map((e) => ({
        ...e,
        // Use the default React Flow edge renderer (bezier with label).
        // The id prefix `fork:` is what the panel's edge-change handler
        // checks to refuse deletion / selection of synthetic edges.
        selectable: false,
        deletable: false,
        animated: false,
        style: {
          stroke: "var(--primary)",
          strokeDasharray: "4 3",
          strokeWidth: 1.5,
        },
        labelStyle: {
          fill: "var(--muted-foreground)",
          fontSize: 10,
        },
        labelBgStyle: {
          fill: "var(--background)",
        },
      })),
    ],
    [edges, editingEdgeId, onStartEditEdge, onCommitEdgeLabel, derivedForkEdges]
  )

  const centerPosition = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return rf.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    })
  }, [rf])

  const addProjectedNode = useCallback(
    (kind: Exclude<CanvasNodeKind, "sticky">, id: string) => {
      setNodes((ns) => {
        if (ns.some((n) => n.id === id)) return ns // dedup
        const node: RfNode = {
          id,
          type: kind,
          position: centerPosition(),
          data: { kind },
        }
        return [...ns, node]
      })
      persistNow()
    },
    [setNodes, centerPosition, persistNow]
  )

  const addSticky = useCallback(() => {
    const node: RfNode = {
      id: uuid(),
      type: "sticky",
      position: centerPosition(),
      data: { kind: "sticky", content: "" },
    }
    setNodes((ns) => [...ns, node])
    persistNow()
  }, [setNodes, centerPosition, persistNow])

  // --- addable groups (workspace items not yet on the canvas) ---------------
  const onCanvasIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])

  const addable: AddableGroups = useMemo(() => {
    const wsArtifacts = artifacts.filter((a) => a.workspaceId === workspaceId)
    const wsNotes = notes.filter((n) => n.workspaceId === workspaceId)
    const wsBookmarks = urlBookmarks.filter(
      (b) => b.workspaceId === workspaceId && !b.deletedAt
    )
    const wsFileIds = new Set(
      resources.filter((r) => r.workspaceId === workspaceId).map((r) => r.fileId)
    )
    const wsFiles = files.filter((f) => wsFileIds.has(f.id) && !f.deletedAt)
    const wsConvs = conversations.filter((c) => c.workspaceId === workspaceId)

    // Recent messages across the workspace's conversations.
    const messageItems: AddableItem[] = []
    const flat: Array<{ id: string; content: string; convTitle: string; ts: number }> = []
    for (const c of wsConvs) {
      for (const m of c.messages) {
        if (m.kind === "recap") continue
        flat.push({
          id: m.id,
          content: m.content,
          convTitle: c.title,
          ts: new Date(m.timestamp).getTime(),
        })
      }
    }
    flat.sort((a, b) => b.ts - a.ts)
    for (const m of flat) {
      if (onCanvasIds.has(m.id)) continue
      messageItems.push({
        id: m.id,
        label: snippet(m.content) || "(empty message)",
        sublabel: m.convTitle,
      })
      if (messageItems.length >= MESSAGE_PICKER_LIMIT) break
    }

    return {
      "chat-message": messageItems,
      artifact: wsArtifacts
        .filter((a) => !onCanvasIds.has(a.id))
        .map((a) => ({ id: a.id, label: a.title || "Untitled", sublabel: a.kind })),
      note: wsNotes
        .filter((n) => !onCanvasIds.has(n.id))
        .map((n) => ({ id: n.id, label: snippet(n.body) || "(empty note)" })),
      file: wsFiles
        .filter((f) => !onCanvasIds.has(f.id))
        .map((f) => ({ id: f.id, label: f.name, sublabel: f.type })),
      "url-bookmark": wsBookmarks
        .filter((b) => !onCanvasIds.has(b.id))
        .map((b) => ({ id: b.id, label: b.title, sublabel: b.url })),
      conversation: wsConvs
        .filter((c) => !onCanvasIds.has(c.id))
        .map((c) => ({
          id: c.id,
          label: c.title || "Untitled",
          sublabel: c.parentId ? "fork" : undefined,
        })),
    }
  }, [
    workspaceId,
    artifacts,
    notes,
    files,
    resources,
    urlBookmarks,
    conversations,
    onCanvasIds,
  ])

  // Keyboard nav (Phase 5): Esc deselects + cancels edge-label editing;
  // arrow keys nudge selected nodes by one grid step. Ignored while a
  // form field is focused (sticky textarea, edge-label input) so typing
  // isn't hijacked. Mounted only while the canvas view is active.
  useEffect(() => {
    const NUDGE: Record<string, [number, number]> = {
      ArrowUp: [0, -GRID],
      ArrowDown: [0, GRID],
      ArrowLeft: [-GRID, 0],
      ArrowRight: [GRID, 0],
    }
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return
      }
      if (e.key === "Escape") {
        setEditingEdgeId(null)
        setNodes((ns) =>
          ns.some((n) => n.selected)
            ? ns.map((n) => (n.selected ? { ...n, selected: false } : n))
            : ns
        )
        setEdges((es) =>
          es.some((ed) => ed.selected)
            ? es.map((ed) => (ed.selected ? { ...ed, selected: false } : ed))
            : es
        )
        return
      }
      const delta = NUDGE[e.key]
      if (!delta) return
      let moved = false
      setNodes((ns) =>
        ns.map((n) => {
          if (!n.selected) return n
          moved = true
          return {
            ...n,
            position: { x: n.position.x + delta[0], y: n.position.y + delta[1] },
          }
        })
      )
      if (moved) {
        e.preventDefault()
        persistDebounced()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setNodes, setEdges, persistDebounced])

  // Export the whole canvas as a PNG (Phase 5). Fits all nodes with a
  // margin, paints the themed background, downloads. Best-effort —
  // surfaces a toast on failure rather than throwing.
  const exportPng = useCallback(async () => {
    const flowNodes = rf.getNodes()
    if (flowNodes.length === 0) {
      toast("Canvas is empty — nothing to export")
      return
    }
    const viewport =
      wrapperRef.current?.querySelector<HTMLElement>(".react-flow__viewport")
    if (!viewport) return
    setExporting(true)
    try {
      const bounds = getNodesBounds(flowNodes)
      const pad = 80
      const width = Math.ceil(bounds.width) + pad * 2
      const height = Math.ceil(bounds.height) + pad * 2
      const t = getViewportForBounds(bounds, width, height, 0.5, 2, 0.1)
      const bg =
        getComputedStyle(document.body).backgroundColor || "#0a0a0a"
      const dataUrl = await toPng(viewport, {
        backgroundColor: bg,
        width,
        height,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.zoom})`,
        },
      })
      const a = document.createElement("a")
      a.href = dataUrl
      a.download = `canvas-${new Date().toISOString().slice(0, 10)}.png`
      a.click()
    } catch (err) {
      console.error("[canvas] PNG export failed", err)
      toast.error("Couldn't export the canvas as PNG")
    } finally {
      setExporting(false)
    }
  }, [rf])

  const onInit = useCallback(
    (instance: ReactFlowInstance<RfNode, Edge>) => {
      instance.setViewport(rf.getViewport())
    },
    [rf]
  )

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <CanvasToolbar
        addable={addable}
        onAdd={addProjectedNode}
        onAddSticky={addSticky}
      />
      {/* Top-right controls: snap-to-grid toggle + PNG export. */}
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
        <Button
          size="sm"
          variant={snapEnabled ? "secondary" : "ghost"}
          onClick={() => setSnapEnabled((v) => !v)}
          className="h-8 gap-1.5 shadow-sm"
          title={snapEnabled ? "Snap to grid: on" : "Snap to grid: off"}
          aria-pressed={snapEnabled}
        >
          {snapEnabled ? <Grid2x2Check size={14} /> : <Grid2x2 size={14} />}
          Snap
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={exportPng}
          disabled={exporting}
          className="h-8 gap-1.5 shadow-sm"
          title="Export canvas as PNG"
        >
          <Download size={14} />
          {exporting ? "Exporting…" : "PNG"}
        </Button>
      </div>
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
          <p className="text-sm text-[var(--muted-foreground)] text-center max-w-xs px-6">
            Your canvas is empty. Use{" "}
            <span className="font-medium">Add to canvas</span> to drop
            messages, artifacts, notes, files, or a sticky note — then drag
            to arrange and connect them.
          </p>
        </div>
      )}
      <ReactFlow
        nodes={nodesWithHandlers}
        edges={edgesWithHandlers}
        onNodesChange={onNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={persistDebounced}
        onNodesDelete={persistNow}
        onEdgesDelete={persistNow}
        onEdgeDoubleClick={onEdgeDoubleClick}
        onMoveEnd={persistDebounced}
        onInit={onInit}
        nodeTypes={canvasNodeTypes}
        edgeTypes={canvasEdgeTypes}
        snapToGrid={snapEnabled}
        snapGrid={[GRID, GRID]}
        deleteKeyCode={["Backspace", "Delete"]}
        proOptions={{ hideAttribution: true }}
        fitView={false}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable className="!hidden md:!block" />
      </ReactFlow>
    </div>
  )
}

// --- panel (provider boundary) ----------------------------------------------

export function CanvasPanel() {
  const workspace = useActiveWorkspace()

  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-sm text-[var(--muted-foreground)]">
        No active workspace.
      </div>
    )
  }

  return (
    <div className="h-full w-full">
      <ReactFlowProvider>
        {/* key forces a fresh provider + seed when the workspace changes —
            simplest correct boundary for per-workspace canvas state. */}
        <CanvasInner key={workspace.id} workspaceId={workspace.id} />
      </ReactFlowProvider>
    </div>
  )
}
