# Plan: Flowchat canvas — conversation forks as canvas nodes

Status: **planning.** Item #7 from
`docs/PLAN-cross-product-inspirations.md`. Composition of two
surfaces Hummingbird already ships — `forkConversation`
(`lib/client/hooks/store/slices/conversations.ts`) and the
workspace canvas (`components/panels/canvas.tsx`,
`lib/shared/canvas/`). Estimated scope: M (multi-day, one PR).

## Why

When you fork a conversation today (right-click any assistant
message → Branch), the new conversation appears in the sidebar as a
sibling. The fork relationship is captured in the row
(`Conversation.parentId` + `Conversation.forkedFromMessageId`) and
nothing reads it. Result: you can fork "Q4 OKRs draft" three times
to explore variants, but the only visible structure is a flat
sidebar list.

Msty's Flowchat treats forks as a spatial tree on a pan/zoom
canvas. Hummingbird already has the canvas surface + the fork data
— this plan wires them together so the tree is visible, navigable,
and grows automatically as the user branches.

## Decisions pinned before drafting

These came up in conversation and are pinned here so a future
reader can see *why* each shape was picked.

1. **Keep both the sidebar AND the canvas tree.** Sidebar stays
   authoritative for the flat list of conversations. Canvas is a
   *curated spatial view* of the same data. Users who don't open
   the canvas never see any change.
2. **Clicking a message node inside a forked conversation stays in
   that conversation.** You don't jump to the parent just because
   the message exists in the parent's history too. Same rule as
   today — node click = set active conversation + active view, no
   special-casing for forked messages.
3. **The canvas remains freely editable for positions and
   user-decoration edges.** This was a real risk to avoid: if the
   user can draw fork edges by hand, the "fork tree" rendering
   stops meaning anything (it'd be a mix of real fork edges +
   wishful-thinking edges). Resolution: **fork edges are *derived*
   at render time, not stored in `canvasState.edges`.** They render
   in a distinct style with a "fork" label. User-drawn edges
   continue to render with the existing style. Two visually
   separate layers; the user can connect anything they want, the
   system never confuses an annotation edge for a fork
   relationship.
4. **Conversation node placement seeds once on fork, then user
   owns it.** Same precedent as artifact auto-placement (Phase 4
   of `PLAN-workspace-canvas`, shipped in #90): the system picks a
   sensible spot near the source-message node when the fork
   happens, and from then on the user can drag, re-style, or
   delete the canvas node freely. Deleting from the canvas does
   NOT delete the conversation — the sidebar entry stays.
5. **Re-forking from the same source after a user deleted the
   canvas node** seeds a fresh node at the auto-place coordinates;
   no resurrection of the previous canvas position. Same shape as
   artifact re-placement today.

## Shape — new node kind + derived edges

### 1. New node kind: `"conversation"`

`CanvasNodeKind` (`lib/shared/canvas/types.ts`) gains a
`"conversation"` literal. The node `id` is the conversation id (so
`parseCanvasState` de-dup and the existing
`stripSelectionId(kind: "conversation")` helper just work).

Node body is **projected** from the conversation row at render time
— consistent with how message/artifact/note nodes work today.
Renderer shows:
- Title (`conversation.title`, "Untitled" fallback)
- A small message-count chip (`conversation.messages.length`)
- The first line of the latest assistant message (truncated to
  ~60 chars) as a hover-only preview
- Subtle "(fork of …)" subtitle when `parentId` is set, with the
  parent's title for orientation

No new content state on the node itself — same "projected kind"
shape the other domain nodes use.

### 2. Derived fork edges (NOT in `canvasState.edges`)

Render-time: walk `state.conversations` filtered to the active
workspace; for every conversation with `parentId != null` AND
`forkedFromMessageId != null`, emit a synthetic edge from the
source-message node → the conversation node.

Synthetic edges:
- Live ONLY in the React Flow render pass (`edges={[
  ...storedEdges, ...derivedForkEdges]}`).
- Have a stable id pattern (`fork:${conversationId}`) so React
  Flow's reconciler can update them in place.
- Render with a distinct style (solid accent color, "fork" label,
  arrow at the target).
- Are non-editable: React Flow's edge config sets
  `deletable: false` + `selectable: false` on the synthetic edges.
  The store mutator that handles edge deletion ignores them anyway
  (they don't exist in `canvasState.edges`).

Edge from source-message node → conversation node only emits when:
- The source-message node is currently on the canvas (the
  `forkedFromMessageId` resolves to a node in `state.nodes` for
  THIS workspace's canvas), AND
- The conversation node is currently on the canvas.

If either node has been deleted from the canvas, the synthetic
edge silently no-ops — same defensive shape as
`parseCanvasState`'s edge dropping when endpoints are missing.

### 3. Auto-place on `forkConversation`

Today's `forkConversation` already calls
`forkConversationJoins(state, source.id, fork.id, uuid)` to copy
the selection joins. Add a sibling step: when the source workspace
has a non-empty canvas AND the source-message id corresponds to a
canvas node, place a `"conversation"` node for the new fork beside
it via the existing `placeRelatedNode` helper.

This mirrors `artifacts.ts`'s auto-place block (lines 72-90):

```ts
if (sourceCanvas && sourceCanvas.nodes.length > 0) {
  const sourceMessageNodeIndex = sourceCanvas.nodes.findIndex(
    (n) => n.id === untilMessageId,
  )
  if (sourceMessageNodeIndex >= 0) {
    const nextCanvas = placeRelatedNode(sourceCanvas, {
      sourceNodeId: untilMessageId,
      newNode: {
        id: fork.id,
        kind: "conversation",
        position: { x: 0, y: 0 }, // overwritten by placement
      },
    })
    // patch the workspace row with the new canvas state
    patches.workspaces = state.workspaces.map((w) =>
      w.id === source.workspaceId ? { ...w, canvasState: nextCanvas } : w,
    )
  }
}
```

No new placement primitive — `placeRelatedNode` already finds an
unoccupied spot near the source node.

### 4. Click → jump

Conversation node `onClick`:

```ts
setActiveConversation(node.id)
setActiveView("chat")
```

Same affordance as the existing chat-message and artifact node
clicks. The canvas panel stays mounted (no unmount cost) but the
viewport flips to the chat panel.

## Sequencing — one PR, three commits

1. **Commit 1 — type + parser:** `CanvasNodeKind` gains the
   `"conversation"` literal; `parseCanvasState`'s `VALID_KINDS`
   gets the new entry. Renderer renders nothing yet — adding the
   type first means the next commit can drop nodes onto an
   existing canvas without breaking the parser, even if the user
   downgrades and rehydrates.
2. **Commit 2 — auto-place + click:** Extend `forkConversation` in
   the conversations slice to seed a `conversation` node on the
   source canvas. Add the node renderer + click handler.
3. **Commit 3 — derived fork edges:** Compute the synthetic-edge
   list at render time, merge into the React Flow `edges` prop,
   pin them as non-deletable + non-selectable.

Each commit is independently shippable — if commit 3 needs more
research, 1 + 2 still leave the canvas in a strictly better
state (you can manually drop conversation nodes; the fork tree
just isn't auto-traced).

## Tests

- **`parseCanvasState`** — extend the existing test file with a
  case for the new node kind round-tripping cleanly + a case for a
  malformed conversation node being dropped.
- **Derived-edges builder** — extract `buildDerivedForkEdges(
  conversations, canvasState)` as a pure helper in
  `lib/shared/canvas/` so it's unit-testable. Cases: empty
  conversations, root conversation only, fork with both nodes on
  canvas (edge emitted), fork with source-message node missing
  (edge skipped), fork with conversation node missing (edge
  skipped), multi-level chain (grandchild edge emitted between
  grandparent's message and grandchild conversation).
- **Auto-place on fork** — extend the `forkConversation` test in
  `conversations.test.ts` with a workspace that has a canvas + the
  source-message node placed; assert the new conversation node
  lands and that `parentId` + `forkedFromMessageId` survive.
- **No store changes for canvas edge state** — assert that
  `forkConversation` does NOT touch `canvasState.edges` (the
  synthetic edges are render-only).

## What's NOT in scope

- **Bulk fork operations.** "Fork at this message into N variants"
  is a separate UX — useful but distinct.
- **Conversation node previews beyond title + count.** Showing
  message bubbles inline on the canvas is visually appealing but
  expensive (every text-delta would re-render the node). Hover
  preview is enough for v1.
- **Cross-workspace forks.** Forking is workspace-scoped today;
  this plan inherits that constraint.
- **A "fork tree" sidebar entry kind.** Some power-user clients
  (LibreChat) show fork relationships in the sidebar via
  indent + tree affordance. Out of scope — we have the canvas for
  visual structure now; the sidebar stays flat.
- **Re-parenting forks by dragging.** If you drag a conversation
  node next to a different parent, the data doesn't update — the
  fork relationship comes from `parentId`, which is set at fork
  time and never re-written. Spatial proximity is just spatial
  proximity.

## Open questions before commit 1

These need a one-line answer before code lands; each picks a
default if no answer comes in.

1. **Width of the conversation node.** Today's other node kinds
   render at ~280px wide. Conversation nodes carry less inline
   content (title + chip + subtitle) so 220px probably feels
   better — but worth a quick mock before committing. **Default:
   220px, revisit on first usage.**
2. **Style of derived fork edges.** Should they have the "fork"
   label inline (visible in the viewport) or only on hover?
   Discoverable vs noisy. **Default: visible label, single small
   word, in muted text color.**
3. **What happens when a conversation node is on the canvas but
   its conversation row has been deleted?** Sidebar deletion is
   irreversible; canvas should track. Two options: (a) leave the
   orphan node visible as a tombstone "(removed)" placeholder, or
   (b) auto-strip from `canvasState.nodes` on conversation
   deletion. **Default: (b) — strip via the same cascade
   `stripSelectionId` already does for other deleted entities.**

## Reopen triggers

A v2 of this plan would be justified if:
- Users start asking for inline message previews on conversation
  nodes (means the canvas is doing real work, not decorative)
- Cross-workspace forks become a request (means the workspace
  boundary is the wrong frame)
- The "fork tree" surface picks up enough traction to displace
  the sidebar as the primary navigation for forked conversations
