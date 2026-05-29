# Plan: Workspace canvas

Status: **✅ All phases shipped.** Phases 1–3 in #83 (canvas surface +
node renderers, `canvas_state` persistence + sync, add / connect /
focus). Phases 4–5 in `claude/canvas-phases-4-5` (PR pending):
auto-position artifacts near their source message (Phase 4); inline
edge-label editor, snap-to-grid, keyboard nav (Esc deselect + arrow
nudge), and PNG export (Phase 5). Mini-map shipped back in Phase 1.
Implementation notes that diverged from this plan: uses
`@xyflow/react` v12 (the current package for react-flow; the v11
`reactflow` name predates React 19). Not built (deliberately, beyond
the plan's scope): SVG export and auto-layout solver — open as
follow-ups only if requested.

A freeform spatial view of a workspace's content. Chat messages,
artifacts, notes, and files become draggable cards on an infinite
canvas; arrows between them capture relationships ("this artifact
was generated from that message", "this file was attached to that
note"). Lets a research session live somewhere other than a linear
chat scroll.

## Why

Hummingbird is already producing the right *content* for spatial
organisation — artifacts, notes, attached files, branched
conversations — but the only view is linear chat. Power users
working on research, writing, or code review build mental graphs
that linear chat can't hold.

A canvas is a different *view* of data that already exists. It
doesn't require new content types. It's distinctive: tldraw / Excalidraw
are pure whiteboards, Notion's canvas is shallow, and no AI chat app
has shipped a meaningful one.

## Goal & scope cuts

**v1 ships:**

- A "Canvas" view alongside Chat / Editor, scoped to the active
  workspace.
- Nodes for: `chat-message`, `artifact`, `note`, `file`,
  `url-bookmark`. Each renders a compact card with the same content
  the existing panels show.
- Free pan, free zoom, drag to move, click to focus + open the
  underlying object in the right panel.
- Connections between nodes (drawn arrows, manual). Persisted.
- Auto-position new nodes near related ones (e.g. an artifact node
  spawned near the chat-message node it came from).

**Out of v1:**

- Auto-layout / re-layout. Stick with the user's free positions.
- Multi-select operations beyond "select & drag a group".
- Embedding the canvas inside another conversation as a "view"
  (cross-workspace).
- Real-time collaboration. Defer alongside Realtime Phase 3.

## Architecture

```
+----------------------------------+
| Workspaces / Chat / Editor /     |
| Canvas (new view in the activity |
|         bar)                     |
+--------+-------------------------+
         |
         v
+--------------------------+
| CanvasView (new panel)   |
|  ┌────────────┐          |
|  │ react-flow │ <── reads workspace.canvas_state
|  │  + custom  │ <── reads messages / artifacts / notes / files
|  │  node      │       from the existing Zustand slices
|  │  renderers │
|  └────────────┘
+--------------------------+
         |
         v
+--------------------------+
| canvas_state JSONB on    |
| workspaces row           |
|  { nodes: [...], edges:  |
|    [...], viewport: {…} }|
+--------------------------+
```

Backed by **react-flow** (mature, MIT-licensed, ~50 KB gzipped). The
alternative — `tldraw` — is more polished but heavier and harder to
embed nodes that are React components in a strict app theme.

## Phases

### Phase 1 — Canvas surface + node renderers (≈ 1.5 days)

**Dependencies.** `react-flow` (npm: `reactflow` v11+).

**New components:**

- `components/panels/canvas.tsx` — the panel-level container.
- `components/canvas/node-message.tsx`,
  `node-artifact.tsx`, `node-note.tsx`, `node-file.tsx`,
  `node-url-bookmark.tsx` — five custom node types.
- `components/canvas/canvas-toolbar.tsx` — pan-zoom controls + a
  small palette to add a free-form sticky note.

**Activity-bar entry.** Add "Canvas" alongside the existing views in
`components/sidebars/application.tsx`. Icon: `LayoutGrid`.

**Phase-1 state model.** All nodes are *projections* of existing
data — no separate "canvas content" table. The only new state is
position + connections, stored as `canvas_state` on the workspace.

### Phase 2 — Persistence + sync (≈ 1 day)

**Migration** — alter the workspaces table:

```sql
alter table workspaces
  add column canvas_state jsonb;
```

The JSON shape:

```ts
type CanvasState = {
  nodes: Array<{
    id: string                    // matches the underlying row id
    kind: 'chat-message' | 'artifact' | 'note' | 'file' | 'url-bookmark' | 'sticky'
    position: { x: number; y: number }
    width?: number
    height?: number
    // For 'sticky' (a free-form note that has no backing row).
    content?: string
  }>
  edges: Array<{
    id: string
    source: string
    target: string
    label?: string
  }>
  viewport: { x: number; y: number; zoom: number }
}
```

Sync handler diffs `canvas_state` like a single document field (whole
object replaced on change, debounced 500 ms). No per-node sync for
v1; the JSON is small (KBs).

### Phase 3 — Add / connect / focus (≈ 1 day)

**Add.** A "+" button in the canvas toolbar opens a picker: which
existing artifact / note / file / message? Or sticky? Selected item
gets a new node positioned at the canvas viewport centre.

**Connect.** Drag from a node's right edge handle to another node's
left edge handle. Creates a new edge. Click an edge to add a label.
Right-click → delete.

**Focus.** Click a node → opens the underlying object in the right
panel (existing chat-message focus, artifact preview, etc.). Two
panels open at once — left side keeps the canvas, right shows the
detail.

### Phase 4 — Auto-position from new artifacts (≈ half day)

When a new artifact / note is created **and** the canvas exists for
this workspace, append a node positioned near the related message
node (if any) at an offset. No layout solver — just "spawn 240 px
to the right of the source", clamped to viewport.

### Phase 5 — Polish (deferred, optional)

- Mini-map.
- Keyboard nav (arrow keys, Esc to deselect).
- Export the canvas as PNG / SVG.
- Snap-to-grid toggle.

## Verification

1. Open a workspace with messages + artifacts. Switch to Canvas;
   verify no nodes appear yet (canvas starts empty).
2. Click + → add an existing artifact. Node appears centred. Drag
   it; refresh; position survives (canvas_state persisted).
3. Connect two nodes with an edge. Refresh; edge survives.
4. Click a chat-message node → right panel opens at that message
   with the same scrolled-to / highlighted treatment as a normal
   message bookmark.
5. Generate a new artifact from a chat message. Verify the new node
   appears on the canvas next to the message node (Phase 4
   auto-position).
6. Sync: open the same workspace on a second device, verify the
   canvas state syncs.

## Out of scope

- Auto-layout algorithms. The whole point of a canvas is the user's
  arrangement; we don't second-guess it.
- Cross-workspace canvases. v1 is per-workspace.
- Real-time multi-user editing. Falls under the broader Realtime
  Phase 3.
- Treating canvas nodes as a first-class source the model can
  retrieve from. Possible follow-up if it becomes a request.
