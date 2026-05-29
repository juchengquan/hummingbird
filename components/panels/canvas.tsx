"use client"

import "@xyflow/react/dist/style.css"

import { useCallback, useEffect, useMemo, useRef } from "react"
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react"

import { useStore, useActiveWorkspace } from "@/client/hooks/use-store"
import { uuid } from "@/shared/uuid"
import {
  emptyCanvasState,
  type CanvasNodeKind,
  type CanvasState,
} from "@/shared/canvas/types"
import { canvasNodeTypes, type CanvasNodeData } from "@/components/canvas/canvas-nodes"
import {
  CanvasToolbar,
  type AddableGroups,
  type AddableItem,
} from "@/components/canvas/canvas-toolbar"

type RfNode = Node<CanvasNodeData>

const PERSIST_DEBOUNCE_MS = 450
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

  const onEdgeDoubleClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      // Minimal label affordance: prompt for text. A richer inline editor
      // is a polish follow-up (see PLAN Phase 5).
      const next = window.prompt(
        "Edge label",
        typeof edge.label === "string" ? edge.label : ""
      )
      if (next === null) return
      setEdges((eds) =>
        eds.map((e) =>
          e.id === edge.id ? { ...e, label: next || undefined } : e
        )
      )
      persistNow()
    },
    [setEdges, persistNow]
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
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={persistDebounced}
        onNodesDelete={persistNow}
        onEdgesDelete={persistNow}
        onEdgeDoubleClick={onEdgeDoubleClick}
        onMoveEnd={persistDebounced}
        onInit={onInit}
        nodeTypes={canvasNodeTypes}
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
