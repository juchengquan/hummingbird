# Plan: Conversation-private file attachments

Status: **✅ shipped**. `ConversationFile` lane lives alongside workspace `Resource` lane; see `lib/client/hooks/use-store.ts` (`addConversationFile` / `removeConversationFile`) and migration `0004_conversation_files.sql`.

A second lane of file attachments that live and die with one
conversation, sitting alongside the existing workspace-library lane.
After this lands, files have two distinct shapes of belonging:
workspace-scoped (visible across all conversations in the workspace,
ticked on/off per conversation) and conversation-private (visible only
inside one conversation, never enters the workspace library).

## Why

Today every upload — whether triggered from the workspace's
`ChatResourcesPanel` or the chat input's `+` button — flows through
the workspace as a `Resource`, and "attaching to a conversation" is
just a checkbox on top (`selectedFileIds` on `Conversation`). Two
problems:

1. **Pollution.** A receipt you dropped into one chat to ask a quick
   question shows up forever in every other chat's "Workspace files"
   list.
2. **"Remove from conversation" is misleading.** It unticks the file
   but leaves it sitting in the workspace, which surprises users who
   expected it to be gone.

The fix is to give the in-thread upload gesture (the chat input `+`)
its own private lane that the workspace library can't see.

## Schema decision: file-specific, not polymorphic

A polymorphic `conversation_attachments { kind, ref_id }` table was
considered so URLs and MCP-resource bindings could ride on the same
join later. Rejected for v1 because:

- URLs and MCP resources are still hypothetical here.
- An MCP resource is a *binding* (live pointer to an external system),
  not an uploaded blob — different lifecycle, different GC story.
- Migration cost from `conversationFiles` → polymorphic table is one
  SQL script and a store-shape change, deferrable until the second
  source type actually lands.

So: a dedicated `ConversationFile` join, with the option to revisit
when MCP/URL source types arrive.

## Data model

`lib/shared/types.ts`:

```ts
export interface ConversationFile {
  id: string              // uuid
  conversationId: string
  fileId: string          // FK into the global files[] array
  addedAt: string
}

// + tombstone field on the existing UploadedFile
export interface UploadedFile {
  id: string
  name: string
  size: number
  type: string
  uploadedAt: string
  extractedText?: string  // freed at tombstone time
  storage_path?: string   // freed at tombstone time
  external_url?: string   // freed at tombstone time
  deletedAt?: string      // ISO timestamp — soft-delete marker
}
```

`files[]` stays the single registry of file metadata. `ConversationFile`
is a join row, parallel in shape to `Resource` (the workspace lane).

## Store changes (`lib/client/hooks/use-store.ts`)

### New slice

```ts
conversationFiles: ConversationFile[]
```

### New mutators

- `addConversationFile(conversationId, fileId)` — generate uuid, push.
- `removeConversationFile(conversationId, fileId)` — filter the row out,
  then call `gcOrphanedFile(fileId)` (see below).
- `clearConversationFilesFor(conversationId)` — used by
  `deleteConversation` cascade.

### Cascade rules (atomic, inside a single `set`)

After **any** mutator that removes a file or join row, the following
invariant must hold: *no join row references a missing or tombstoned
file, and `selectedFileIds` contains no missing fileIds.*

Mutators to update:

- `removeFile(fileId)` — drop from `files[]` *(tombstone, not hard
  delete, see below)*; drop matching `resources`; drop matching
  `conversationFiles`; strip `fileId` from every conversation's
  `selectedFileIds`.
- `clearFiles()` — tombstone every file; drop all `resources`, all
  `conversationFiles`, and every `selectedFileIds`.
- `removeConversationFile(conversationId, fileId)` — drop the join
  row; then `gcOrphanedFile(fileId)`.
- `removeResource(workspaceId, fileId)` — drop the resource row; strip
  `fileId` from every `selectedFileIds`; then `gcOrphanedFile(fileId)`.
- `deleteConversation(conversationId)` — drop matching
  `conversationFiles`; then `gcOrphanedFile` for each affected fileId.
- `deleteWorkspace(workspaceId)` — cascade through conversations in
  that workspace (existing logic) + drop their `conversationFiles`.

### Defensive prune on hydrate

In the `persist` `migrate` step (bump store version to 4) and in
`onRehydrateStorage`:

1. Drop `conversationFiles` rows whose `fileId` is missing from
   `files[]` or whose file is tombstoned.
2. Drop `resources` rows whose `fileId` is missing or tombstoned.
3. Strip missing/tombstoned `fileId`s from every conversation's
   `selectedFileIds`.

Cheap (one pass per array), no-op on healthy data, covers cross-tab
races and any future bugs in new mutators.

### New selector

```ts
useConversationPrivateFiles(): UploadedFile[]
// Inner-join conversationFiles where conversationId === activeConversationId
// against files[]. Filter out deletedAt != null. Skip dangling rows.
```

Render-side join, not lookup-and-trust — UI degrades to "file removed"
or just skips rather than crashing on `undefined`.

## Tombstone (soft-delete) semantics

Hard-deleting a file row would silently break future references to it
(structured citations, notes pinned to messages that referenced the
file, artifacts derived from it). The mitigation is a tombstone: keep
the metadata stub, free everything expensive.

### What "free the blob" means in practice

| What | Where it lives | Size | Tombstone treatment |
|---|---|---|---|
| File metadata (`id, name, size, type, uploadedAt`) | `files[]` in Zustand → localStorage | ~100 bytes | **Keep**, set `deletedAt` |
| Binary content (PDF/image bytes) | UploadThing CDN or Supabase Storage | KB-MB | **Free** via provider delete API |
| Extracted text (`extractedText`) | localStorage via persist | up to ~32 KB | **Free** — `extractedText: undefined` |
| Any future content-ish field (thumbnail, etc.) | localStorage | varies | **Free** at tombstone time |

### `gcOrphanedFile(fileId)`

Helper called from `removeConversationFile`, `removeResource`,
`deleteConversation`, `deleteWorkspace`. Logic:

1. Find the file in `files[]`. If missing or already tombstoned, no-op.
2. Count live references: `resources.some(r => r.fileId === fileId)`,
   `conversationFiles.some(cf => cf.fileId === fileId)`.
3. If any live ref remains, return without tombstoning.
4. Otherwise tombstone:
   - Best-effort cloud delete: `supabase.storage.from('user-files').remove([storage_path])`
     and/or `utapi.deleteFiles([key])` for UploadThing. Failures
     are logged but do not block tombstoning; the orphan blob on the
     provider side is not user-visible and can be cleaned up later
     by an offline-retry sync op or a periodic compaction job.
   - Set `deletedAt = new Date().toISOString()`, `extractedText = undefined`,
     `storage_path = undefined`, `external_url = undefined`.

### `removeFile` policy

`removeFile(fileId)` (the user-initiated "delete this file" action,
e.g. via the workspace library overflow menu) always tombstones —
regardless of remaining references — because the user explicitly asked
for it to be gone. Cascade still runs (joins are dropped, selectedFileIds
stripped) so the UI matches.

### Render-side filtering

Wherever `files[]` is iterated:

- Workspace library (`ChatResourcesPanel` "Workspace files" section)
  → filter `deletedAt == null`.
- Conversation-private section → filter `deletedAt == null`.
- `useConversationPrivateFiles()`, `useWorkspaceResources()` selectors
  → filter at the join.
- The chat-route payload builder → filter `deletedAt == null` before
  sending to `app/api/chat/route.ts`.

Future structured citations (post-extraction) can resolve a `fileId`
to `{ name, deletedAt }` and render "🗑 contract.pdf (removed)" instead
of dangling.

## Upload routing

Two upload entry points, explicitly named:

- `uploadToWorkspace(file)` — `addFile` + `addResource` + `toggleConversationFileSelection`
  *(current behavior of every upload today)*.
- `uploadToConversation(file)` — `addFile` + `addConversationFile`.
  No `resources` row.

Three callers to wire after this change:

- `ChatResourcesPanel`'s "Workspace files" section's upload button →
  `uploadToWorkspace` (unchanged).
- `ChatResourcesPanel`'s "This conversation" section's upload button
  → `uploadToConversation` (new section).
- The chat input's `+` button (`components/panels/chat.tsx:650`) →
  `uploadToConversation` by default. This is the "drop a file into
  this chat" gesture, and the no-pollution behavior is exactly what
  users expect from it.

## UI changes

`components/panels/chat-resources-panel.tsx`:

1. Two stacked sections: **"This conversation"** on top,
   **"Workspace files"** below. Both render the same `FileRow`.
2. Each section has its own upload button + drop target.
3. Empty states: "No files attached to this conversation yet." /
   "No files in this workspace yet."
4. Hover actions:
   - Conversation-private: **Remove** — calls `removeConversationFile`
     (which tombstones if it was the last ref).
   - Workspace: existing tick/untick toggle; overflow menu retains
     "Remove from workspace" → `removeResource`.
5. Small visual marker on conversation-private rows (Lock icon, or
   dotted left border) so the distinction is legible at a glance.
6. *(Optional, follow-up)* "Save to workspace" action in the overflow
   menu of a conversation-private row — promotes it by calling
   `addResource(activeWorkspaceId, fileId)` while keeping the existing
   `conversationFiles` row. The de-dup logic in the chat-route
   payload (see below) covers the dual-membership case.

`components/panels/chat.tsx`:

- The chat-input `+` upload calls `uploadToConversation` instead of
  the current three-call sequence at `chat.tsx:650-652`. One-line
  change.

## Chat-route payload

`components/panels/chat.tsx:682-` currently builds the file payload
from `conv.selectedFileIds` only. After the change:

```ts
const workspaceFileIds = conv?.selectedFileIds ?? []
const privateFileIds = conversationFiles
  .filter(cf => cf.conversationId === conv.id)
  .map(cf => cf.fileId)
const attachedFileIds = [...new Set([...workspaceFileIds, ...privateFileIds])]
  .filter(id => {
    const f = files.find(x => x.id === id)
    return f && !f.deletedAt
  })
```

Resolves to file objects against `files[]` as today and sends in the
request body. No API contract change — `app/api/chat/route.ts` doesn't
care where the files came from.

## What does NOT change

- `app/api/chat/route.ts` — same payload shape, same handling.
- The file-extraction code path — extraction is per-`UploadedFile`,
  works identically for both lanes.
- `UploadedFile` shape, beyond the additive `deletedAt?: string` field.
- The global `files[]` array as the single metadata registry.
- The Supabase sync layer (still unshipped). When sync lands, two
  new handlers slot in alongside `resources`:

  ```sql
  create table conversation_files (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    conversation_id uuid not null references conversations(id) on delete cascade,
    file_id uuid not null references files(id) on delete cascade,
    added_at timestamptz not null default now()
  );
  create index on conversation_files (conversation_id);
  ```

  Plus a `deleted_at timestamptz` column on the future `files` table
  mirroring the client field.

## Verification

1. **Private upload via chat `+`** — file appears in "This conversation"
   only; the workspace library does **not** show it; chat API receives
   it on the next message.
2. **Workspace upload via panel** — appears in "Workspace files,"
   ticked for the current conversation; visible (unticked) from a
   sibling conversation in the same workspace.
3. **Switch conversations** — "This conversation" section repopulates
   correctly per active conversation; sibling conversations don't leak
   private files between each other.
4. **Delete a conversation** — its `conversationFiles` rows drop;
   `gcOrphanedFile` tombstones any file whose only ref was that
   conversation; storage blob is freed; metadata stub remains in
   `files[]` with `deletedAt`.
5. **`removeFile(id)` on a doubly-referenced file** (in `resources` +
   `conversationFiles`) → all three places (resources,
   conversationFiles, every `selectedFileIds`) are pruned atomically;
   file is tombstoned; no dangling joins.
6. **Reload the browser** — `conversationFiles` survive via
   localStorage; store version migrates 3 → 4 without throwing;
   defensive prune drops nothing on healthy data.
7. **Hand-edit localStorage** to add a dangling `conversationFiles`
   row pointing at a non-existent fileId → on next load, defensive
   prune drops it; no UI crash.
8. **Dual membership** — same `fileId` in both `resources` (ticked) and
   `conversationFiles` → chat-route payload sends it **once** (Set
   de-dup); both UI sections show it.
9. **Tombstoned file rendering** — manually set `deletedAt` on a file
   that's referenced by a `conversationFiles` row; reload → UI filters
   it out of both file lists; no crash from the dangling ref; chat-
   route payload skips it.
10. **Offline cloud-delete failure** — disable network, trigger a
    tombstone via `removeConversationFile`; metadata is tombstoned
    locally; provider blob remains (orphan); console logs the failure;
    UI is unaffected.

## Out of scope (follow-ups)

- **"Save to workspace" promotion** for a conversation-private file —
  trivial one-liner once the rest is solid; not blocking.
- **Polymorphic `conversation_attachments`** — defer until a second
  non-file source type (URL, MCP resource) lands.
- **Hard-delete compaction** of long-tombstoned files — separate
  periodic job, only after we've confirmed nothing depends on the
  metadata stub (notes, artifacts, future structured citations).
- **Undo for `removeConversationFile`** — the tombstone makes undo
  *possible* (metadata is still there) but the UI isn't designed yet.
- **Provider-side orphan cleanup** when cloud delete fails — a sync-
  queue retry op or periodic reconciliation against Supabase Storage
  listing.

---

Estimated diff: ~200-250 lines, concentrated in `use-store.ts`,
`chat-resources-panel.tsx`, `lib/shared/types.ts`, and the chat-route
payload builder in `chat.tsx`.
