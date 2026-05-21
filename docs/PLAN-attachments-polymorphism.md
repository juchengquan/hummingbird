# Plan: Consumer-side polymorphism for source attachments

Status: **planning** — no code yet.

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

## The unified types

New file `lib/shared/attachments.ts`:

```ts
import type { McpResource, UploadedFile, UrlBookmark } from './types'

export type AttachmentKind = 'file' | 'mcp_resource' | 'url_bookmark'

/**
 * Conversation-scope attachment. Discriminated union over the three
 * source kinds. The chat route, request builder, and any consumer
 * that wants "everything attached to this turn" works with this
 * shape; storage stays in the per-kind slices.
 */
export type SourceAttachment =
  | { kind: 'file'; id: string; entity: UploadedFile }
  | { kind: 'mcp_resource'; id: string; entity: McpResource }
  | { kind: 'url_bookmark'; id: string; entity: UrlBookmark }

/**
 * Wire shape sent on the chat request body. Each kind ships the
 * minimum the server needs to render the system prompt — for files
 * and URL bookmarks that includes the cached text content; for MCP
 * resources it's the addressing tuple so the server can call
 * `readResource`.
 */
export type AttachmentPayload =
  | { kind: 'file'; summary: FileSummary }       // existing FileSummary, re-exported
  | { kind: 'mcp_resource'; ref: McpResourceRef }
  | { kind: 'url_bookmark'; bookmark: BookmarkRef }

/** Map a SourceAttachment to its kind+id tuple — used by selection
 *  state and de-dup. */
export function attachmentRef(att: SourceAttachment): { kind: AttachmentKind; id: string }
```

The point of the discriminated union is that consumers that *do*
care about the kind keep type-narrowing; consumers that *don't*
(payload de-dup, presence-check, rendering) work generically.

## Server-side: one renderer

Replace the three `render*Prompt` functions plus the inline file
block in `buildSystemPrompt` with one:

```ts
// lib/server/attachments/render.ts
export function renderAttachmentsPrompt(
  attachments: ResolvedAttachment[],
  totalBudget: number
): string | null
```

Where `ResolvedAttachment` is the chat-route's variant — files arrive
with `text` already extracted (no I/O); URL bookmarks arrive with
cached `content` (no I/O); MCP resources arrive **post-`readResource`
call** so by the time the renderer sees them they're text too.

The render groups by kind for readable section headers:
- *Files attached:* …
- *MCP resources attached:* …
- *Bookmarked pages:* …

Within each group, the same per-attachment header + truncation marker
logic — written once. Budget is shared across all kinds; kinds with
higher information density (files first, then MCP resources, then
bookmarks) get priority by passing through in that order.

`buildSystemPrompt` becomes:

```ts
function buildSystemPrompt(opts: {
  workspaceSystemPrompt?: string
  enabledSkills?: string[]
  mcpServers?: { name: string; toolCount: number }[]
  attachments: ResolvedAttachment[]   // the unified list
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

Refactor into a single helper in `lib/client/hooks/use-store.ts`:

```ts
function gcOrphanedAttachment(
  state: AppState,
  ref: { kind: AttachmentKind; id: string }
): Partial<AppState>
```

Returns a state patch (works inside a Zustand `set`) that tombstones
the entity iff zero refs remain across both lanes and all
conversations. The per-kind details (which slice holds the entity,
which tombstone function, which IDB blob to free) live in a single
switch — verbose at definition but every consumer becomes a one-line
call.

`deleteConversation`'s cascade — today ~50 lines of three near-
identical blocks — becomes ~15 lines:

```ts
const affectedRefs = collectConversationAttachmentRefs(state, conversationId)
const newJoins = dropConversationJoins(state, conversationId)
const patches = affectedRefs.map(ref => gcOrphanedAttachment({ ...state, ...newJoins }, ref))
return mergeStatePatches(newJoins, ...patches)
```

`deleteWorkspace` likewise.

`forkConversation`'s "copy private joins onto the fork" gets a
helper `forkConversationJoins(state, sourceId, forkId)` returning
the join arrays to merge into the state.

## What stays the same

To make the diff reviewable in one PR:

- Every Supabase migration. No DB changes.
- The Zustand store **shape** — three slices, three sets of join
  arrays, three selection-id arrays. Only the *mutator implementations*
  shrink.
- The sync layer (`lib/client/sync/*`). The three `diff*` functions
  + the reconcile path stay.
- The three resource-sidebar tab components (Files / Links / MCP).
- The three add-flow dialogs (file upload, URL paste, MCP server
  picker).
- Every chat-route Zod schema field — three separate arrays
  (`files`, `mcpResources`, `urlBookmarks`) stay in
  `ChatRequestSchema` for one release. The route accepts both:
  - **Legacy**: the three separate arrays (existing clients).
  - **New**: a single `attachments` array (new client code).
  Both go through `toAttachmentList()` and merge into one
  `ResolvedAttachment[]`. The old fields stay through one stable
  release, then a follow-up commit deletes them.

## Phasing

Two sub-commits inside one PR, each independently typechecks +
lints:

| Sub-commit | Scope | LOC delta |
|---|---|---|
| **1** | New `lib/shared/attachments.ts` + new server renderer. Chat-route migrates to `body.attachments`. Client request builder migrates. Three legacy `render*Prompt` functions stay for one release so existing in-flight requests still work. | +280 / -120 |
| **2** | Store cascade helper. Mutators migrate (`removeFile`, `removeResource`, `removeMcpResourceBinding`, `removeConversationFile`, `removeConversationMcpResource`, `removeConversationUrlBookmark`, the four-lane cascade in `deleteConversation` + `deleteWorkspace`, `forkConversation` inheritance). | +130 / -260 |

Net after both: ~+410 / -380, so ~+30 LOC. The win is structural,
not line-count.

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
