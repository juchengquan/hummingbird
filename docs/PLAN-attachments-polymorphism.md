# Plan: Consumer-side polymorphism for source attachments

Status: **✅ shipped**. Discriminated union lives in `lib/shared/api-schemas.ts` (`AttachmentPayloadSchema`) and `lib/shared/attachments.ts`; the chat route consumes the unified shape via `resolveAttachments` in `app/api/chat/route.ts`.

We now have three nearly-identical source lanes — **files**, **MCP
resources**, **URL bookmarks** — each with its own type, its own
workspace + conversation-private pair, its own chat-route renderer,
its own cascade rules, its own selectors. Every future cross-lane
feature (drag-paste, attachment search, content extraction, share
links, recap) requires writing the same code three times.

This refactor unifies the **consumer-facing types and helpers**
across all three lanes while leaving storage (store slices, Supabase
tables, sync handlers) intact. The user-facing UI stays distinct (the
three resource-sidebar tabs are intentional). Net: ~400 LOC change,
zero schema migration, no behavioural diff that the user can see.

## Why now

Three real implementations means we can read the diff between them
honestly. The plan that shipped URL bookmarks called this out
explicitly:

> *Polymorphic merge with files and MCP resources — three parallel
> lane pairs starts to argue for a unified `attachments` abstraction.
> Worth a refactor after this lands, when we have three real
> implementations to compare.*

Doing it now (before the fourth source type arrives) is cheap.
Doing it after means writing the fourth lane in parallel first.

## What we have today

For each of files / MCP resources / URL bookmarks:

| Layer | Files | MCP | URL bookmarks |
|---|---|---|---|
| Persisted entity | `UploadedFile` | `McpResource` | `UrlBookmark` |
| Workspace lane | `Resource` join | `McpResourceBinding` join | (`workspace_id` on the row) |
| Conversation-private lane | `ConversationFile` | `ConversationMcpResource` | `ConversationUrlBookmark` |
| Workspace-tick on conversation | `selectedFileIds` | `selectedMcpResourceIds` | `selectedUrlBookmarkIds` |
| Chat-payload field | `files: FileSummary[]` | `mcpResources: …[]` | `urlBookmarks: …[]` |
| System-prompt renderer | inline in `buildSystemPrompt` | `renderMcpResourcesPrompt` | `renderBookmarksPrompt` |
| Tombstone helper | `tombstoneFile` | `tombstoneMcpResource` | `tombstoneUrlBookmark` |
| Store cascade | hand-written, 30-ish lines per mutator × 4 mutators | same shape | same shape |

The chat-route system-prompt builder is a particularly clear case —
three near-identical loops with three slightly different headers and
the same character-budget logic repeated three times. There are 34
mentions of `stillReferenced` / `orphan` across the store today,
~95% in the three-lane GC paths.

## Decisions baked in upfront

### 1. Consumer-side polymorphism only — no schema migration

Three separate Supabase tables stay. Three store slices stay. Three
sync diff handlers stay. The unification lives in:

- A single discriminated-union type that consumers can hold.
- Helpers that turn the three store slices into that union shape.
- A single renderer that the chat route uses.
- A single cascade helper that the store mutators call.

Rationale: a full polymorphic refactor (one `attachments` table,
JSON-shaped subfields, polymorphic FK) is structurally clean but
costs a destructive Supabase migration and loses some type safety in
the sync layer. The "consumer-side" cut gets us 80% of the
readability win for 20% of the risk.

### 2. UI tabs stay distinct

Users want **Files** / **Links** / **MCP** as separate tabs in the
resources sidebar. Each has its own affordances (file upload, URL
paste, MCP server picker) that don't unify naturally. The refactor
is code-level only; nothing changes in the rendered UI.

### 3. Sync diff handlers stay separate

`diffFiles`, `diffMcpResources`, `diffUrlBookmarks` each map row
shapes column-by-column to their respective Supabase tables. The
column lists really *are* different — collapsing into one generic
function would push the type unsafety into a stringly-typed dispatch.
Leave them.

### 4. The three `selectedXxxIds` columns on `Conversation` stay

`conversations.selected_file_ids`, `selected_mcp_resource_ids`,
`selected_url_bookmark_ids` could in principle merge into a single
JSONB column or a polymorphic join table. Not worth the migration.
Keep three columns; expose a unified accessor at the type layer.

## The three names — three jobs

The refactor introduces three closely related but distinct types.
Naming them clearly upfront avoids one being silently used where
another is wanted:

| Name | Where it lives | What it carries | Used by |
|---|---|---|---|
| `SourceAttachment` | Client store, post-selector | `{ kind, id, entity: …}` — the *full* entity dehydrated from the store | UI components that need to render an attachment row, hover preview, etc. |
| `AttachmentPayload` | Wire (chat request body) | `{ kind, … }` minus client-only fields, plus only what the server needs | `ChatRequestSchema.attachments`, the client request builder |
| `ResolvedAttachment` | Server-side, post-resolution | Like `AttachmentPayload` but with MCP resources' content fetched in | The new `renderAttachmentsPrompt` |

The three exist because:

1. The store has the full entity (e.g. `UploadedFile` with extraction
   status, image data URL, summary, etc.). UI rows want to read all
   of that.
2. The wire shouldn't pay for fields the server doesn't need
   (e.g. `imageDataUrl` for the chat route — it cares about text,
   not the base64 image preview).
3. MCP resources arrive on the wire as **pointers** (`serverId`,
   `uri`) but reach the renderer as **content** (post-`readResource`).
   That fan-out is exactly what `ResolvedAttachment` is for —
   keep the type distinction so a reviewer can't accidentally
   write a renderer that takes `AttachmentPayload` and crashes on
   an MCP resource it forgot to resolve.

## The unified types

New file `lib/shared/attachments.ts`:

```ts
import type { McpResource, UploadedFile, UrlBookmark } from './types'

export type AttachmentKind = 'file' | 'mcp_resource' | 'url_bookmark'

/**
 * Store-side discriminated union. Each variant carries the *full*
 * entity exactly as it lives in the Zustand store. UI rows, hover
 * cards, refresh buttons, anything that wants the rich entity
 * shape consumes this.
 */
export type SourceAttachment =
  | { kind: 'file'; id: string; entity: UploadedFile }
  | { kind: 'mcp_resource'; id: string; entity: McpResource }
  | { kind: 'url_bookmark'; id: string; entity: UrlBookmark }

/**
 * Wire shape sent on the chat request body. Each kind ships only
 * the minimum the server needs to render the system prompt.
 *
 * Important asymmetry: files and URL bookmarks carry their text
 * content here (already extracted client-side); MCP resources carry
 * only the addressing tuple (`serverId` + `uri`) because content
 * lives on the remote MCP server and we fetch it server-side at
 * chat time via `readResource`. The shape encodes that asymmetry
 * directly so it can't be forgotten.
 */
export type AttachmentPayload =
  | { kind: 'file'; summary: FileSummary }
  | { kind: 'mcp_resource'; ref: { serverId: string; uri: string; name: string; mimeType?: string } }
  | { kind: 'url_bookmark'; bookmark: { url: string; title: string; content: string; contentTruncated: boolean; fetchedAt: string } }

/** Map a SourceAttachment to its kind+id tuple — used by selection
 *  state and de-dup. */
export function attachmentRef(att: SourceAttachment): { kind: AttachmentKind; id: string }
```

A separate `ResolvedAttachment` lives in `lib/server/attachments/render.ts`
(server-only) — see the next section.

## Server-side: one renderer

`lib/server/attachments/render.ts`:

```ts
export type ResolvedAttachment =
  | { kind: 'file'; summary: FileSummary }
  | { kind: 'mcp_resource'; serverName: string; resourceName: string; text?: string; error?: string }
  | { kind: 'url_bookmark'; title: string; url: string; content: string; truncated: boolean; fetchedAt?: string }

export function renderAttachmentsPrompt(
  attachments: ResolvedAttachment[],
  totalBudget: number
): string | null
```

`ResolvedAttachment` is the **post-resolution** shape:

- Files arrive verbatim from `AttachmentPayload['file']` (no
  resolution needed — text was extracted client-side at upload).
- URL bookmarks arrive verbatim from `AttachmentPayload['url_bookmark']`
  (no resolution needed — content was extracted server-side at save
  time via `/api/url/fetch` and now lives on the bookmark row).
- **MCP resources** arrive as the result of a `readResource` call.
  The existing `resolveAttachedMcpResources` helper (already in
  `lib/server/mcp/inject-resources.ts`) does this dance —
  concurrent reads with 5s per-call timeout, error fallback. It
  stays. We just teach it to emit `ResolvedAttachment` instead of
  the current `ResolvedResource` shape.

Wire-to-resolved happens in `app/api/chat/route.ts` between schema
validation and prompt build:

```ts
const resolved: ResolvedAttachment[] = []
for (const att of body.attachments ?? []) {
  if (att.kind === 'file') resolved.push({ kind: 'file', summary: att.summary })
  else if (att.kind === 'url_bookmark') resolved.push({ kind: 'url_bookmark', ...att.bookmark })
}
const mcpReqs = (body.attachments ?? []).filter(a => a.kind === 'mcp_resource')
const mcpResolved = await resolveAttachedMcpResources(mcpReqs, mcpServers)
resolved.push(...mcpResolved)
```

The renderer groups by kind for readable section headers:
- *Files attached:* …
- *MCP resources attached:* …
- *Bookmarked pages:* …

Within each group, one header + truncation-marker loop, written
once. Budget shared across all kinds; ordering (files → MCP →
bookmarks) reflects information density.

`buildSystemPrompt` becomes:

```ts
function buildSystemPrompt(opts: {
  workspaceSystemPrompt?: string
  enabledSkills?: string[]
  mcpServers?: { name: string; toolCount: number }[]
  attachments: ResolvedAttachment[]
}): string
```

Net: ~80 LOC deleted from `app/api/chat/route.ts`, ~60 LOC added in
the new shared renderer.

## Client-side: one selector, one request builder

New hook in `lib/client/hooks/use-conversation-attachments.ts`:

```ts
export function useConversationAttachments(): SourceAttachment[]
```

Returns the de-duped, tombstone-filtered union across both lanes
(workspace-ticked + conversation-private) for every kind. Selector
internally uses the existing per-kind selectors (so the existing
selectors don't have to change), then merges + dedupes by
`(kind, id)`.

Consumers that today do this manually three times — `components/panels/chat.tsx`'s
request builder is the biggest — collapse to:

```ts
const attachments = mcpStoreSnapshotToAttachments(mcpStore, conv)
const payload = attachments.map(toAttachmentPayload)
// → ships as body.attachments
```

Then the chat input's "X attached" indicator (which today is per-
kind across three slices) becomes one count. Future "search across
attachments" or "share an attachment set" work off this hook.

## Store-side: cascade helper

The store has four mutators (`removeFile`, `removeResource`,
`removeMcpResourceBinding`, `removeConversationUrlBookmark`, etc.)
that all follow the same shape:

1. Drop the matching join row(s).
2. Check whether the underlying entity has any other live reference
   (other join in the same lane, the other lane's join, the
   `selectedXxxIds` array on each conversation).
3. If no live ref remains: tombstone the entity, free expensive
   fields, fire-and-forget any blob cleanup.

Three slightly-different `tombstoneXxx` helpers. Three nearly-
identical `stillReferenced` calculations. Same in
`deleteConversation` and `deleteWorkspace` cascades.

Refactor into a small `lib/client/store/cascade.ts` module — kept
*outside* `use-store.ts` so the helpers are independently testable
and the store file doesn't keep growing. Two pure functions:

```ts
/**
 * For a given (kind, id), inspect the state and return true iff
 * any live reference remains: workspace join row, conversation-
 * private join row, or `selectedXxxIds` array on any conversation.
 *
 * Pure — caller decides what to do with the answer. Doesn't read
 * tombstone state because tombstoned entities never have live joins
 * after Stage 1 (cascade drops them atomically).
 */
export function hasLiveReference(state: AppState, ref: AttachmentRef): boolean

/**
 * Build a state delta that tombstones the given entity if it has
 * no live references. No-op if refs remain. Pure: returns the
 * partial state change; caller composes inside a single Zustand
 * `set()` call.
 *
 * Per-kind details (which slice the entity lives in, which fields
 * the tombstone preserves vs frees, which IDB blob to enqueue for
 * deletion) live in a single `switch` here — verbose at definition
 * but the rest of the codebase becomes one-liners.
 */
export function gcOrphanedAttachment(
  state: AppState,
  ref: AttachmentRef
): Partial<AppState>
```

Why pure + delta-shaped rather than `(state) => state`: Zustand's
`set` accepts either a full replacement or a partial; callers in
the store today build partials with explicit field names (e.g.
`{ conversationFiles, files, conversations }`). Keeping `gcOrphanedAttachment`
delta-shaped means cascade code stays in the same shape it has
today — composable inside a single `set`, no risk of stale-state
reads between two `set` calls. Concrete example for the now-
simplified `deleteConversation`:

```ts
deleteConversation: (conversationId: string) =>
  set((state) => {
    const newConversations = state.conversations.filter((c) => c.id !== conversationId)
    // Drop join rows for this conversation across all three lanes.
    const droppedJoins = dropConversationJoins(state, conversationId)
    // For every (kind, id) that lost a ref, run GC against the
    // post-drop state. Most calls are no-ops because workspace
    // refs survive.
    const orphanRefs = collectAffectedRefs(state, droppedJoins)
    let patch: Partial<AppState> = { conversations: newConversations, ...droppedJoins }
    for (const ref of orphanRefs) {
      patch = { ...patch, ...gcOrphanedAttachment({ ...state, ...patch }, ref) }
    }
    // Plus the existing per-feature cleanups (notes, artifacts, pins, etc.)
    return { ...patch, notes: …, artifacts: …, pinnedExplanations: … }
  })
```

The reducer-style accumulator (`patch = { ...patch, ...gcOrphanedAttachment(...) }`)
is explicit and reads top-to-bottom; no `mergeStatePatches` magic.

`deleteWorkspace` follows the same shape.

`forkConversation`'s "copy private joins onto the fork" gets a
helper `forkConversationJoins(state, sourceId, forkId)` returning
the new join rows to append. The three `selectedXxxIds` arrays on
the new conversation are copied directly in the existing
`createConversation`-shaped block — they live on the conversation
itself, not in join tables, so they're not "joins" to inherit via
this helper. The fork code stays explicit about copying them.

## What stays the same

To keep the PR reviewable:

- Every Supabase migration. No DB changes.
- The Zustand store **shape** — three slices, three sets of join
  arrays, three selection-id arrays. Only the *removal/cascade*
  mutator implementations shrink.
- The sync layer (`lib/client/sync/*`). The three `diff*` functions
  + the reconcile path stay.
- The three resource-sidebar tab components (Files / Links / MCP).
- The three add-flow dialogs (file upload, URL paste, MCP server
  picker).
- **Per-kind mutators that aren't about cascade.** The refactor only
  touches *removal* + *cascade* logic. Operations that are
  inherently per-kind stay per-kind because their patch shapes
  diverge wildly:
  - `addFile`, `setFileExtraction`, `setFileStorage` — file-specific
    extraction lifecycle.
  - `addMcpServer`, `setMcpServerCapabilities`, `setMcpServerEnabled`,
    `upsertMcpResource`, `addMcpResourceBinding` — MCP-specific
    discovery + binding flow.
  - `addUrlBookmark`, `updateUrlBookmark` — URL-bookmark refresh
    semantics (re-fetch + content-hash comparison) don't make sense
    on the other kinds.
  - All three add-flow surfaces stay distinct in the store.
- **Wire shape changes atomically.** Files, MCP resources, URL
  bookmarks have one client (this app) and no external API
  consumers — so `ChatRequestSchema` swaps its three fields
  (`files`, `mcpResources`, `urlBookmarks`) for one (`attachments`)
  in one commit. No dual-shape compat layer. The client request
  builder and the chat route change together; one PR, one shape.
- **`Message.attachedFileIds`** — the per-message snapshot of
  what was attached at send time — stays file-specific. It exists
  to render "I sent these files in this message" chips below
  user messages; the equivalent doesn't make sense for ephemeral
  MCP resources (the resource may have changed between send and
  re-render) or for URL bookmarks (the bookmark can be refreshed
  out from under the message). Promoting it to a kind-discriminated
  list of `(kind, id)` tuples is a future feature, not part of this
  refactor.
- **Defensive prune on hydrate** (`onRehydrateStorage`). Today's
  pass already iterates the three slices independently — it doesn't
  share the GC/tombstone logic, just the ref-counting question.
  The refactor exports `hasLiveReference` from the new
  `cascade.ts` so the prune pass can use it, but the prune
  *itself* stays where it is and continues to handle each slice
  by name (the loop is short and the file-by-file structure is
  what makes a reviewer trust it).

## Phasing

Two sub-commits inside one PR, each independently typechecks +
lints:

| Sub-commit | Scope | LOC delta |
|---|---|---|
| **1** | New `lib/shared/attachments.ts` + `lib/server/attachments/render.ts`. Chat-route swaps `files`/`mcpResources`/`urlBookmarks` → `attachments` atomically. Client request builder migrates in the same commit. Three legacy `render*Prompt` files deleted (the existing `resolveAttachedMcpResources` is *kept* — it still does the per-resource read + timeout dance). | +280 / -220 |
| **2** | New `lib/client/store/cascade.ts` with `hasLiveReference` + `gcOrphanedAttachment`. Removal mutators migrate (`removeFile`, `removeResource`, `removeMcpResourceBinding`, `removeConversationFile`, `removeConversationMcpResource`, `removeConversationUrlBookmark`, plus the cascade blocks in `deleteConversation` + `deleteWorkspace`, plus `forkConversation` private-join inheritance via the new `forkConversationJoins` helper). | +180 / -310 |

Net after both: ~+460 / -530, so **~−70 LOC**. The win is mostly
structural — every consumer site shrinks 30-50% in branch count —
but we end up with a smaller codebase too.

## Verification

Heavy reliance on the existing typecheck + lint + the manual smoke
loops we've used for the underlying features. Specifically:

1. **Typecheck + lint clean** after each sub-commit.
2. **Send a chat with one of each attachment type** (a file with
   extracted text, an MCP resource, a URL bookmark) and confirm:
   - All three appear in the model's view (use a deliberately silly
     question that forces the model to reference each).
   - The system prompt section headers read cleanly.
   - The character budget is respected (truncation marker appears
     when oversized).
3. **Cascade smoke**:
   - Remove a file referenced by both a `resources` row and a
     `conversationFiles` row → confirm both joins drop atomically;
     no tombstone on the underlying file because the workspace ref
     still exists. Then remove the resource → file tombstones.
   - Same for MCP resource removal across lanes.
   - Same for URL bookmark removal — should match Stage 2 behaviour
     of the URL bookmarks feature.
   - Delete a workspace with mixed attachments → all join rows go,
     all underlying entities tombstone, no dangling refs.
4. **Fork smoke**: fork a conversation that has all three kinds of
   private attachments → fork carries all three over.
5. **Sync regression**: sign in on two browsers, attach one of each
   kind on browser A → browser B sees all three after reconcile.
   Crucial because the sync layer is *not* refactored; this just
   confirms the new mutators still emit the same `set` operations
   the existing diff handlers expect.
6. **Reload-after-tombstone**: tombstone a file then reload —
   defensive prune should still drop dangling joins (this path is
   sensitive to the exact tombstone shape; want to confirm we
   didn't regress).

## What this does NOT enable

- **Attachment search across types** — gets *easier* (one shape to
  search) but still needs a search UI + index. Out of scope.
- **Drag-paste in the chat input** — likewise easier (one upload
  helper that discriminates by type) but the UX is its own work.
- **Per-attachment content versioning** — orthogonal.
- **Share-link for an attachment set** — needs the shares-table
  pattern from MCP / files share-link work; orthogonal.

## What we'll learn (and use later)

The `ResolvedAttachment` shape is also what a future *fourth* source
type plugs into — say, a database row binding, a GitHub repo
pointer, or a cross-conversation memory snippet. The cost of adding
a fourth kind after this lands is:

- Add a `'database_row'` case to the union (one line + the entity
  type).
- Write its store slice + sync handler + add-flow UI (work that
  doesn't change).
- Implement the per-kind branch in `gcOrphanedAttachment` (one
  switch arm).
- Implement the per-kind rendering in `renderAttachmentsPrompt` (one
  switch arm).

The chat route, client request builder, cascade in
`deleteConversation` / `deleteWorkspace`, and the attached-count
indicator don't change.

---

Estimated total ~410 LOC change net, ~600 LOC touched. Two sub-
commits inside one PR. Implementation can start immediately after
sign-off on this plan; no design questions left dangling.
