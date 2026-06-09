# Plan: Real-time collaborative editing + AI as a CRDT peer

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(second research round, 2026-06-09) to **Next**. Scope: **L** — and
**gated on the multi-tenant / document-sharing story** (see
[Prerequisite](#prerequisite--the-multi-tenant-gate)). Origin: the 2026
"AI agent as a Yjs CRDT peer" pattern — see [Sources](#sources).

## Why

Hummingbird's Plate editor is single-user: AI commands apply edits to
the local Slate value, and comments/suggestions persist to Supabase but
aren't live-multiplayer. The 2026 collaboration pattern is Yjs CRDTs +
presence, with a twist that fits Hummingbird perfectly — **the AI agent
joins the document as a server-side Yjs peer**, editing live alongside
humans with a visible cursor and a presence status (thinking /
composing / idle), instead of returning a blob the client splices in.

It's the most differentiated idea of the second research round, and the
editor is already most of the way there:

- Plate's `EditorKit` already bundles **`CursorOverlayKit`** (cursor
  overlays) and **`AIKit` / `CopilotKit`** — the presence + AI surfaces.
- The diff-review surface (`ai-review-pill.tsx`, #49) already gates AI
  hunks with accept/reject — that stays as the AI-edit governance layer.

What's missing is the Yjs layer itself: there is **no `@platejs/yjs` /
`yjs` dependency today**, and documents persist as a **markdown string**
(`documents` slice, `setDocumentContent`), not a CRDT state.

## Prerequisite — the multi-tenant gate

Live co-editing only matters once a document can have **more than one
human editor** — i.e. document sharing / multi-tenant workspaces. Today
Hummingbird is per-user. This is the same gate that parked Open WebUI
Channels in the inspirations skip-list. So this plan is **promoted to
Next for design, but its build is sequenced after a sharing story
lands.** The one piece worth doing early (and which has single-user
value) is the **AI-as-peer** refactor — it makes the editor's AI edits
flow through a CRDT even before humans share docs, de-risking the later
multiplayer turn.

## Non-goals — what this is NOT

- **Not a rewrite of the AI command surface.** The edit/generate/
  comment/table intents and the diff-review gate stay. Only the
  *transport* of edits changes (local Slate ops → Yjs ops).
- **Not OT.** CRDTs (Yjs), not Operational Transformation — the 2026
  consensus for local-first/offline-capable collaboration.
- **Not a self-built sync server from scratch.** Use Hocuspocus
  (self-host) or a managed peer (Liveblocks) behind an adapter.
- **Not real-time chat-panel collaboration.** Scope is the *editor
  document*, not multi-user chat threads.

## Decisions to pin before code

1. **CRDT + plugin.** Yjs (fastest CRDT lib in 2026) via `@platejs/yjs`.
   Reuse the already-present `CursorOverlayKit` for remote cursors.
2. **Sync server.** Self-host **Hocuspocus** (Node, open-source) behind
   an adapter so a managed provider (Liveblocks) can swap in. **Default:
   Hocuspocus self-host** — matches the project's self-host posture.
3. **Document state model.** Today a document is a markdown string. Yjs
   needs a `Y.Doc` binary update log. **Default: Yjs `Y.Doc` becomes the
   live source of truth; markdown stays the canonical *export/snapshot*
   serialised on save** (so existing features that read
   `document.content` keep working). Migration stores the Y.Doc state
   (`bytea`) alongside the markdown snapshot.
4. **The AI peer.** AI edits flow through a server-side Yjs client
   (a Hocuspocus connection) with its own awareness identity ("AI"),
   applying edits as a participant. The diff-review surface still gates
   them — AI hunks land as *suggestions* the human accepts/rejects, now
   as Yjs operations.
5. **Presence.** Awareness carries `{ name, color, cursor, status }`;
   the AI peer broadcasts `status: thinking | composing | idle`.
6. **Offline / conflict.** CRDTs converge by construction; the markdown
   snapshot is written on a debounce + on `pagehide`, reusing the
   existing debounced-storage pattern.

## Shape — code surface

### Phase A — AI-as-peer over Yjs (single-user value, no sharing yet)

- Add `yjs` + `@platejs/yjs` + a Hocuspocus client; extend `EditorKit`
  (`components/editor/editor-kit.tsx`) with the Yjs plugin bound to a
  per-document room id.
- `services/collab/` — a Hocuspocus server (self-host), authenticated
  with the existing Bearer-JWT; one room per `documentId`, RLS-checked.
- Migration `0024_document_crdt.sql` — `documents.ydoc_state bytea`
  (the Y.Doc update log) + keep `content` (markdown snapshot).
  `documents` slice gains load/persist of the binary state; `setDocument
  Content` becomes "serialise the Y.Doc → markdown snapshot."
- Refactor the editor AI commands (`components/editor/use-chat.ts`) so
  applied edits go through the Yjs document as the "AI" awareness
  identity; `ai-review-pill.tsx` still governs accept/reject.

### Phase B — human multiplayer (gated on sharing)

- Document sharing model (invite / link) — **the gating dependency**;
  belongs to the multi-tenant story, referenced here, planned there.
- Presence avatars + remote cursors (`CursorOverlayKit`) for human
  peers; awareness wired to the auth identity.
- Per-document access control on the Hocuspocus room (RLS-equivalent
  on connect).

## Sequencing — PR series

1. **PR 1 — Yjs document state + snapshot migration.** Introduce the
   Y.Doc as the live model, markdown as the serialised snapshot;
   migration + `documents`-slice load/persist; no server yet (local
   Y.Doc). Pure-ish, regression-guarded: existing single-user editing +
   `document.content` readers unchanged.
2. **PR 2 — Hocuspocus self-host + AI peer.** The sync server
   (JWT-auth, room-per-document); route AI command edits through the
   Yjs doc as the "AI" awareness identity; presence status; diff-review
   still gates. Single-user-meaningful (the AI edits live with a
   visible cursor).
3. **PR 3 (gated) — human multiplayer.** Wire to the document-sharing
   model when it lands: human presence, remote cursors, per-room access
   control.

## Tests

- **Snapshot round-trip (PR 1)** — Y.Doc ⇄ markdown snapshot is stable
  (serialise → deserialise → serialise is idempotent); existing
  `document.content` readers see the snapshot. Pure.
- **AI-peer edits (PR 2)** — an AI command applies edits as Yjs ops
  tagged with the AI identity; the diff-review pill still surfaces them;
  accept/reject mutate the shared doc correctly.
- **Auth on room connect (PR 2)** — a connection without a valid JWT /
  without doc access is rejected.
- **Manual smoke** — AI generates into a doc and you see its cursor +
  "composing" status; accept/reject works; reload restores from the
  Y.Doc state; (Phase B) two browser tabs co-edit with visible cursors.

## Open questions before PR 1

1. **Y.Doc as source of truth vs markdown.** Making Yjs canonical is
   cleaner long-term but touches every `document.content` reader.
   **Default: Yjs canonical + markdown snapshot (above); the snapshot
   keeps existing readers working with no churn.**
2. **Sync-server hosting.** A new always-on service to operate.
   **Default: a small `services/collab` Hocuspocus process alongside
   the agent service; managed (Liveblocks) as the no-ops option behind
   the adapter.**
3. **Is Phase A worth shipping without sharing?** The AI-as-peer refactor
   has modest single-user value (a nicer live-edit UX) but real
   *de-risking* value for the eventual multiplayer turn. **Default: yes
   — ship A, sequence B behind sharing.**

## Reopen / future work

- **Comments/suggestions as CRDT** — move the already-present Discussion
  / Comment / Suggestion plugins onto the shared Yjs doc so they're
  multiplayer too.
- **Multiple AI peers** — a subagent-orchestration
  ([plan](PLAN-subagent-orchestration.md)) team co-editing a doc, each a
  distinct awareness identity (needs the conflict story tested hard).
- **Canvas co-presence** — extend presence to the workspace canvas.

## Sources

- [AI agents as CRDT peers with Yjs (Electric)](https://electric.ax/blog/2026/04/08/ai-agents-as-crdt-peers-with-yjs)
- [CRDTs and real-time collaboration (2026)](https://zylos.ai/research/2026-01-29-crdt-real-time-collaboration/)
- [Multi-user collaboration: CRDTs + real-time syncing (2026)](https://blog.weskill.org/2026/04/multi-user-collaboration-crdts-and-real.html)
