# Plan: URL bookmarks as live sources

Status: **planning** — no code yet.

Paste a URL → server fetches + extracts text → cache as a workspace
or conversation-private "bookmark" → its content gets injected into
chat turns alongside files and MCP resources. The third source type
after files and MCP, sharing the same lane / tombstone / cascade
patterns we just shipped.

## Why

Today, the only way a user can get web content into a chat is to
paste it manually or enable the `webSearch` skill (which doesn't
pin specific pages — the model picks). Both lose fidelity: paste
truncates long pages and pollutes the message; webSearch is
session-local and re-runs from scratch every turn. URL bookmarks
close the gap — "I want *this specific page* to be context for
this conversation."

Builds on infrastructure already in the codebase:
- `app/api/extract/route.ts` already extracts HTML to text via
  `node-html-parser`. The URL fetch path reuses the same extractor.
- File and MCP attachment lanes already use the workspace +
  conversation-private model; URL bookmarks slot in as a third
  parallel pair.
- `lib/server/mcp/inject-resources.ts` is the template for the
  chat-route content injection (timeout + budget + graceful
  "unavailable" placeholder).

## Decisions baked in upfront

- **Server-side fetch, always.** Direct browser → URL is CORS-blocked
  for most useful sites; fetching client-side also surfaces user IP
  to the target. The server route handles fetch + extraction +
  caching + SSRF protection.
- **Sync content, not just metadata.** Extracted text is typically
  10-100 KB per URL after HTML stripping. Worth syncing across
  devices so a signed-in user doesn't get inconsistent context, and
  so we don't re-fetch on every device.
- **Manual refresh, not automatic TTL.** Pages change. We don't
  auto-refresh — a `Refresh` button on each row re-fetches and
  updates content + `fetched_at`. Predictable, no surprise re-fetch
  cost, no surprise "the model now thinks X changed."
- **Two lanes, parallel to files and MCP.** Workspace-library
  bookmarks (across all conversations in the workspace) +
  conversation-private bookmarks (scoped to one chat). Same picker
  UX, same tombstone semantics.
- **Cap extracted text at 200 KB per bookmark.** Same idea as the
  per-file budget. Larger pages get truncated at extraction time
  with a marker; the model sees a heads-up.

## Schema

`lib/shared/types.ts`:

```ts
export interface UrlBookmark {
  id: string
  workspaceId: string
  url: string                     // canonical (post-normalization)
  title: string                   // extracted from <title>, fallback to URL host
  /** Extracted plain text from the page body, capped to 200KB. */
  content: string
  /** True when extraction hit the per-bookmark budget. */
  contentTruncated: boolean
  /** Wall-clock timestamp of the most recent successful fetch. */
  fetchedAt: Date
  /** SHA-256 of `content` — lets the UI show "no changes since last fetch". */
  contentHash: string
  /** Site's reported `<meta>` description or first paragraph snippet. */
  description?: string
  /** Site favicon URL (for the list-row icon). Optional — list still
   *  renders if the site doesn't expose one. */
  faviconUrl?: string
  /** Soft-delete marker (matches UploadedFile.deletedAt). */
  deletedAt?: Date
  createdAt: Date
  updatedAt: Date
}

/** Conversation-private lane (parallel to ConversationFile and
 *  ConversationMcpResource). */
export interface ConversationUrlBookmark {
  id: string
  conversationId: string
  bookmarkId: string
  addedAt: Date
}
```

Plus `Conversation.selectedUrlBookmarkIds?: string[]` — workspace-
library bookmarks ticked on for this conversation. Mirrors
`selectedFileIds` and `selectedMcpResourceIds`.

## URL fetch + extraction pipeline

New server route: `app/api/url/fetch/route.ts` (POST). Body
`{ url }`. Response:

```ts
{
  ok: true,
  bookmark: {
    url, title, content, contentTruncated, contentHash,
    description, faviconUrl, fetchedAt
  }
}
```

### Validation + anti-SSRF (critical)

Before fetching, normalize the URL and reject:

- `file://`, `data:`, `javascript:` — only `http(s)` allowed.
- IPv4 ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `127.0.0.0/8`, `169.254.0.0/16` (link-local).
- IPv6 equivalents: `::1`, `fc00::/7`, `fe80::/10`.
- Hostnames that resolve to private IPs (DNS rebinding) — verify
  *after* DNS lookup, not just the textual hostname.
- Localhost / `.local` / `.internal` / `*.svc.cluster.local`
  (Kubernetes).

Use the existing pattern from any similar handler in the codebase if
present, otherwise a small `lib/server/url/validate.ts` helper. Hard-
fail with 400 on rejection; never silently allow.

### Fetch behavior

- 10 s timeout via `AbortController`.
- Max 5 redirects, all of which re-run the SSRF check.
- 5 MB response body cap (refuse to download larger pages).
- `Accept: text/html, application/json, text/plain;q=0.9, */*;q=0.5`.
- `User-Agent: Hummingbird-Bookmark/1.0 (+https://github.com/juchengquan/hummingbird)`
  so polite sites can identify us.

### Extraction

`lib/server/url/extract.ts` — reuses `node-html-parser` (already in
deps via `/api/extract`):

1. Parse HTML.
2. Strip `<script>`, `<style>`, `<noscript>`, `<svg>`, `<nav>`,
   `<footer>`, `<aside>` — typical noise.
3. Pull `<title>` (fallback: `og:title`, fallback: hostname).
4. Pull `<meta name="description">` or first non-empty `<p>` text
   as `description`.
5. Pull `<link rel="icon">` / `<link rel="shortcut icon">` →
   `faviconUrl` (resolve against base URL).
6. Concatenate text content of `<main>`, `<article>`, or `<body>`
   in that priority order.
7. Truncate at 200 KB (`contentTruncated = true` when hit).
8. SHA-256 the content for `contentHash`.

Non-HTML responses (`application/json`, `text/plain`,
`text/markdown`) — keep verbatim, same 200 KB cap, no parsing.

### Rate limiting

Per-user (session): 30 fetches per minute, sliding window. In-
memory `Map<userId, Timestamps[]>` is fine for v1 — sync layer
makes URL bookmarks somewhat idempotent (a re-fetch produces the
same content, so a malicious retry costs the attacker more than us).
Hardening to a Redis-backed counter is a follow-up if rate becomes
a real concern.

## Store

`lib/client/hooks/use-store.ts`:

New slices:
```ts
urlBookmarks: UrlBookmark[]
conversationUrlBookmarks: ConversationUrlBookmark[]
```

New mutators (matching the file / MCP-resource set):
- `addUrlBookmark(input)` — pushes a new row from the fetch response.
- `updateUrlBookmark(id, patch)` — used by the Refresh action.
- `removeUrlBookmark(id)` — tombstones; cascades joins.
- `addConversationUrlBookmark(conversationId, bookmarkId)` — pin private.
- `removeConversationUrlBookmark(conversationId, bookmarkId)` — unpin + GC.
- `toggleConversationUrlBookmarkSelection(bookmarkId)` — workspace tick.

Tombstone helper `tombstoneUrlBookmark(bookmark)` — keeps id /
workspaceId / url / title / createdAt; frees `content`, `description`,
`faviconUrl`.

Cascade rules (analogous to the file lane):
- `removeUrlBookmark` — drop from joins atomically, strip from every
  conversation's `selectedUrlBookmarkIds`, tombstone the row.
- `removeConversationUrlBookmark` — drop the join; GC the bookmark
  if no other lane refs.
- `deleteConversation` — cascade through `conversationUrlBookmarks`;
  GC orphaned bookmarks.
- `deleteWorkspace` — cascade through bookmarks belonging to that
  workspace.

Defensive prune in `onRehydrateStorage` extends to URL-bookmark joins.

v17 → v18 migration: seed empty slices, backfill `selectedUrlBookmarkIds: []`
on each conversation that needs the field.

## UI

New "Links" tab in the resources sidebar (`resourcesSidebarTab`
union extended). Lucide icon: `Link` or `Bookmark`. Activity-bar
position: between Files and MCP, since URL bookmarks sit
conceptually between local files (static) and MCP resources (live
external systems).

`components/panels/url-bookmarks-tab.tsx` — mirrors the MCP tab's
two-stack layout:

- **"This conversation"** — pinned bookmarks for the active chat.
  Hover row reveals Remove (`X`) and Refresh (`RefreshCw`).
- **"Workspace bookmarks"** — tickable rows backed by
  `selectedUrlBookmarkIds`. Hover reveals Refresh + Remove
  (workspace-level removal cascades).

Each row shows: favicon · title · short URL · "last fetched 2h ago".
Click the row body to expand a hover-card preview of the first ~300
chars of content (so the user remembers what's in there without
opening the source).

Add-bookmark flow:

- "+" button in each section opens an inline input (or a small
  dialog) with a single URL field.
- On submit: POST `/api/url/fetch`, show a small inline spinner
  with "Fetching…", on success run `addUrlBookmark` + the appropriate
  join mutator.
- Errors surface a toast with the failure reason (timeout, SSRF
  rejected, too large, 404, etc.) — same UX as MCP discovery.

Drag-paste support (out of scope for v1): pasting a URL into the
chat input could trigger "Add as bookmark?" — defer to a follow-up.

## Chat-route payload merge

`app/api/chat/route.ts`:

The system prompt currently aggregates files + MCP resources within
the `TOTAL_ATTACHMENT_BUDGET` (96 KB). Add URL bookmarks as a third
class of attachment:

1. Client populates a new `urlBookmarks` field on `ChatRequestSchema`
   with the union of (workspace-ticked via `selectedUrlBookmarkIds`)
   + (conversation-private joins), de-duped, resolved against the
   local store.
2. Server side, no resolution needed — content is already on the
   bookmark row (unlike MCP resources, which need a `readResource`
   call). Just render into the system prompt sharing the budget.
3. Order in the prompt: files first, then MCP resources (live),
   then URL bookmarks (cached). Files have the strongest "user-
   provided" weight; URL bookmarks are reference material.

New helper `lib/server/url/inject-bookmarks.ts` (small — pure render):

```ts
export function renderBookmarksPrompt(
  bookmarks: BookmarkPayload[],
  remainingBudget: number
): { fragment: string | null; used: number }
```

`buildSystemPrompt` signature gains a `urlBookmarks?: BookmarkPayload[]`
parameter; appends the rendered fragment after MCP resources.

System-prompt intro:
> "The user has saved these web pages as bookmarks. Their cached text
> follows; if a fact looks dated, the bookmark may need refreshing."

## Sync layer

New `SyncTarget` entries: `'url_bookmarks'`, `'conversation_url_bookmarks'`.

`lib/client/sync/handlers.ts`:
- `diffUrlBookmarks(prev, next)` — upsert / delete / tombstone.
  Pushes `content_hash` along with `content` so the next reconcile
  can short-circuit "no change since last fetch" comparisons.
- `diffConversationUrlBookmarks(prev, next)` — straightforward join
  upsert / delete.
- `diffConversations` extended to push `selected_url_bookmark_ids`.

`lib/client/sync/reconcile.ts`:
- `fetchCloudSnapshot` pulls both new tables.
- Conversation mapping picks up `selected_url_bookmark_ids`.
- `bulkUploadLocalState` ships bookmarks before joins (FK order:
  workspaces → conversations → url_bookmarks → conversation_url_bookmarks).

`lib/client/hooks/use-sync.ts` snapshot type and ops list extended
in parallel to the MCP wiring.

## Supabase migration `0006_url_bookmarks.sql`

```sql
create table public.url_bookmarks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  url text not null,
  title text not null,
  content text not null default '',
  content_truncated boolean not null default false,
  content_hash text not null,
  description text,
  favicon_url text,
  fetched_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversation_url_bookmarks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  bookmark_id uuid not null references public.url_bookmarks(id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (conversation_id, bookmark_id)
);

alter table public.conversations
  add column selected_url_bookmark_ids uuid[] not null default '{}';

alter table public.url_bookmarks enable row level security;
create policy "own url_bookmarks" on public.url_bookmarks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.conversation_url_bookmarks enable row level security;
create policy "own conversation_url_bookmarks" on public.conversation_url_bookmarks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index url_bookmarks_workspace_live
  on public.url_bookmarks (workspace_id, fetched_at desc)
  where deleted_at is null;
create index conversation_url_bookmarks_conversation
  on public.conversation_url_bookmarks (conversation_id);
```

## Local + cloud parity

Same delivery pattern as the MCP migration. Local-mode users:

- Supabase CLI auto-applies `0006_url_bookmarks.sql` on next `db reset`.
- docker-compose path: `apply-migrations.sh` picks it up automatically.
- Bookmarks live in `localStorage` when signed out; sync to Supabase
  when signed in.

Hosted-cloud users:

- Run `0006_url_bookmarks.sql` in Studio's SQL Editor.
- Add a step to `docs/SUPABASE_SETUP.md` matching the existing
  pattern.

The fetch route (`/api/url/fetch`) works identically in both —
it's a pure server route that talks to the public internet from
the Next.js server tier, no DB dependency for the fetch itself.

## Phasing inside the feature

Two sub-commits keep the diff reviewable:

| Sub-stage | Scope | Lines |
|---|---|---|
| **1** | Types, store, fetch route with SSRF protection, extraction, UI ("Links" tab + add flow), chat-route payload merge. Local-only — no Supabase migration, no sync. | ~600 |
| **2** | Migration `0006_url_bookmarks.sql`, sync handlers, reconcile pulls + bulk upload, generated types. Multi-device works after this. | ~250 |

Stage 1 alone is shippable — users can save URLs and have them in
chat context. Stage 2 unlocks cross-device sync.

## Verification

End-to-end smoke walked manually after each stage:

1. **Schema applied** (Stage 2): `select * from pg_tables where
   schemaname='public' and tablename like 'url%'` returns the two
   new tables. RLS shield visible in Studio.
2. **Anti-SSRF** (Stage 1): try adding bookmarks for
   `http://localhost:8080`, `http://192.168.1.1`, `file:///etc/passwd`.
   All return 400 with a clear reason.
3. **Happy fetch** (Stage 1): bookmark a public article (e.g. an
   MDN page). Title + first paragraph + favicon resolve correctly.
4. **Truncation** (Stage 1): bookmark a deliberately-large page
   (Wikipedia featured article). Content cuts off at 200 KB,
   `contentTruncated = true` set.
5. **Attach flow** (Stage 1): bookmark a page, tick it for the
   current conversation, send a message that needs the page —
   model's answer references the content.
6. **Refresh** (Stage 1): bookmark a page, click Refresh, confirm
   `fetched_at` updates. Edit the source page (or pick one that
   updates frequently), refresh, confirm `content_hash` differs.
7. **Tombstone cascade** (Stage 1): remove a bookmark, confirm joins
   drop, conversation-message references resolve to the tombstoned
   stub.
8. **Multi-device sync** (Stage 2): bookmark on device A → bookmark
   appears on device B with content. Refresh on B → content updates
   on A on next reconcile.
9. **Rate limit** (Stage 1): submit 30+ fetches in 60 s — 31st
   returns 429 with retry-after.
10. **Sign-out preserves local** (Stage 2): bookmark while signed
    in, sign out, bookmark still present in localStorage.

## Out of scope (follow-ups)

- **Auth-protected URLs** — fetching pages behind a login (cookies,
  bearer tokens). Useful but big design surface (per-URL credential
  storage). Defer.
- **JS-rendered pages** — fetching with a headless browser to handle
  SPAs that render client-side. Adds a heavy dep (Playwright /
  Puppeteer) and a runtime container. Defer.
- **PDF / video URL extraction** — same dependency story as JS pages;
  defer. Users can paste PDFs as files instead.
- **Automatic re-fetch on a TTL** — page-staleness detection +
  background refresh. Complicates the UX and adds cost; v1 is
  manual-refresh only.
- **Drag-to-paste / "Add this URL as a bookmark?" prompts** in the
  chat input. Worth doing eventually for discoverability; out of
  scope for v1.
- **Polymorphic merge with files and MCP resources** — three
  parallel lane pairs starts to argue for a unified `attachments`
  abstraction. Worth a refactor *after* this lands, when we have
  three real implementations to compare.
- **Public-share-link of a bookmark** — borrowing the `shares` table
  pattern to expose a bookmark + its content read-only via a token
  URL. Niche use case; defer.

---

Estimated total ~850 lines across ~12 files. Ready to implement on
a branch off `dev` once the conversation-private files + MCP PR
(#3) lands, since both sets of changes touch the resources sidebar
and chat-route payload builder.
