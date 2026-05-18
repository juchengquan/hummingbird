# Branch Analysis: Recommended New Functionalities

## Context

The branch `claude/analyze-codebase-improvements-bYvAH` currently sits on top of two recent feature commits:

- **62c7637** — refactored types/hooks to introduce workspaces, resources, and uploadthing-based file upload; added two real AI API routes (`/api/ai/command`, `/api/ai/copilot`) for the Plate.js editor.
- **790827a** — moved `selectedFileIds` from session-level state onto each `Conversation`, and rebuilt the chat panel as a two-column layout with `ChatResourcesPanel` for per-conversation file attachment.

After this work, the **editor side** of the app has real LLM integration via the AI Gateway (`@ai-sdk/gateway`, `streamText`, tools for comment/table). The **chat side**, by contrast, is still a UI shell: `simulateAIResponse()` in `components/panels/chat.tsx:90` returns a random hard-coded string with a 300 ms `setTimeout` — there is no LLM call, no streaming, and no use of the attached files even though the per-conversation attachment plumbing now exists. Most store mutators (`updateMessage`, `deleteMessage`) also have no UI bindings.

This plan is **recommendations only** — a prioritized list of new functionalities to consider next, with rationale and pointers to the existing code each idea would build on. No implementation is included.

## Recommended new functionalities

Ordered roughly by leverage (impact ÷ effort), given what already exists in the branch.

### 1. Real chat AI integration (highest leverage)

The biggest gap: chat is the headline feature but currently fake. Everything needed to make it real already exists in the codebase.

- **Replace** `simulateAIResponse()` in `components/panels/chat.tsx:90-119` with a streamed call to a new route `app/api/chat/route.ts`.
- **Reuse** the AI Gateway setup pattern from `app/api/ai/command/route.ts:55-57` (`createGateway({ apiKey })`) and `app/api/ai/copilot/route.ts` — same env var (`AI_GATEWAY_API_KEY`), same `streamText` from `ai`.
- **Reuse** `markdownJoinerTransform` from `lib/markdown-joiner-transform.ts` as `experimental_transform` so streamed markdown renders cleanly.
- **Wire in attachments**: the active conversation's `selectedFileIds` (added in 790827a, stored on `Conversation` in `lib/types.ts`) should be resolved to `Resource`/`UploadedFile` objects and injected into the system prompt or message content. Files already flow through `app/api/uploadthing/route.ts` — surface text/PDF content (or at least file metadata) to the model.
- **Streaming UX**: update the assistant message in place as tokens arrive instead of using the all-at-once `addMessage` + `isTyping` flag at `components/panels/chat.tsx:109-117`. The store already has `updateMessage` — use it.

Critical files: `components/panels/chat.tsx`, `lib/hooks/use-store.ts` (add a streaming-state slice), new `app/api/chat/route.ts`, `lib/types.ts` (consider `Message.status: 'streaming' | 'complete' | 'error'`).

### 2. Message-level actions (low effort, high polish)

The store already exposes `updateMessage` and `deleteMessage`, but no UI calls them. Each chat bubble in `components/panels/chat.tsx:195-242` is a good place to add a hover-revealed action row:

- **Copy** message content (clipboard).
- **Delete** message (calls existing `deleteMessage`).
- **Edit** user message → re-trigger AI from that point (requires "truncate-after" semantics — drop messages after the edited one before re-sending).
- **Regenerate** assistant message — same idea: drop the failed/unwanted message and re-call the chat route.
- **Send to editor** already exists implicitly via `setEditorContent`; expose it as an explicit button per assistant message instead of auto-syncing on every send (`components/panels/chat.tsx:115, 132`), which is currently noisy.

Critical files: `components/panels/chat.tsx`, no store changes needed.

### 3. Search & navigation

Once conversations and messages multiply, navigation becomes painful. There is currently no search anywhere.

- **Conversation search in the sidebar**: filter the list in `components/sidebars/conversation-item.tsx` / the sidebar that renders it. Match on title and (optionally) message content.
- **In-conversation message search**: a `⌘F`-style overlay on the chat panel that highlights and jumps to matches.
- **Global cross-workspace search**: optional, but the store already keys conversations by `workspaceId`, so a flat search across all workspaces is straightforward.
- **Keyboard navigation**: `j`/`k` between conversations, `⌘K` command palette for "new conversation / switch workspace / jump to file". The codebase has no shortcuts beyond the sidebar toggle today — a `cmdk`-style palette would pay for itself quickly.

Critical files: the sidebars under `components/sidebars/`, a new `components/command-palette.tsx`.

### 4. Export & sharing

The app produces two artifact types — conversations and editor documents — but neither can leave the browser.

- **Export conversation** as Markdown (trivial: messages → `# user / # assistant` blocks). Add a button to the conversation header.
- **Export editor document** as Markdown / HTML / DOCX. Plate.js has serializers for Markdown and HTML; DOCX would need an extra dep (e.g. `docx` or server-side conversion).
- **Export as PDF**: cheapest path is browser `window.print()` with a print stylesheet; nicer path is server-side via a headless renderer (heavier).
- **Share link**: requires backend persistence — see "Beyond the four areas" below. Without a backend, a "copy as Markdown to clipboard" button is the realistic v1.

Critical files: new `lib/export/` utilities, buttons in `components/panels/chat.tsx` and `components/panels/editor.tsx`.

### Beyond the four areas (worth flagging)

While exploring, several gaps surfaced that are out of scope for this plan but worth naming so you can decide whether to fold them into a follow-up:

- **No backend persistence** — everything is in `localStorage` (`hummingbird-storage`, version 3 in `lib/hooks/use-store.ts`). Chat history, files, and workspaces are device-local and quota-limited. A real DB + auth would unlock share links, multi-device sync, and larger file storage.
- **File content is never extracted** — uploaded PDFs/DOCXs are stored as blobs; nothing parses them into text, so even after wiring real chat AI, the model would only "see" filenames unless extraction is added (e.g. `pdf-parse`, `mammoth`).
- **No error states** — both AI routes swallow errors into a generic 500 (`app/api/ai/command/route.ts:171-176`); the UI has no surface for "AI failed, retry?".

## Verification

This is a recommendations plan with no code changes, so verification is limited to confirming the analysis itself:

1. `git log --oneline -5` on `claude/analyze-codebase-improvements-bYvAH` shows commits `790827a` and `62c7637` as the latest substantive work — confirms the "what changed" framing.
2. `grep -n "simulateAIResponse\|mock response" components/panels/chat.tsx` confirms the chat panel is still mocked (lines ~90-119).
3. `grep -n "updateMessage\|deleteMessage" components/panels/chat.tsx` returns nothing — confirms message-level actions have no UI today.
4. `ls app/api/` shows `ai/command`, `ai/copilot`, `uploadthing` but no `chat` route — confirms #1 is greenfield.

Next step (when you're ready to implement): pick one of the four items above and ask for a focused implementation plan.

## Status (post-implementation)

All four items have shipped on `claude/analyze-codebase-improvements-bYvAH`:

- **Export & sharing** — `6eef625`: `lib/export.ts`, conversation popover entries, editor toolbar buttons, sonner Toaster.
- **Message-level actions** — `9ee6c6a`: `components/panels/chat-message.tsx`, hover-revealed Copy / Edit / Regenerate / Delete; `truncateMessagesAfter` store action.
- **Search & navigation** — `542dc78`: sidebar chat search input, global ⌘K command palette (`components/command-palette.tsx`).
- **Real chat AI integration** — `2186e11`: `app/api/chat/route.ts` via Vercel AI Gateway, `lib/models.ts` (10 models incl. Qwen + DeepSeek), `chatModel` in the store, streaming `callChatAPI` with mock fallback on 401, provider-grouped model picker; later commit added Stop-button / in-flight cancellation.

## Known follow-ups (not yet scoped)

These surfaced during implementation and remain open. Each is a separate piece of work that should be planned before being picked up.

### 1. ✅ File content extraction *(shipped)*

Topology decision (logged in chat): **A — same Next.js app, separate route**, local libs only. Clean interface keeps the door open to swap to (B) standalone service / (C) queue / (D) SaaS later.

New `app/api/extract/route.ts` (Node runtime) accepts a single file via `multipart/form-data` and returns `{ kind, text, truncated }`. Supported kinds: `text` / `markdown` / `csv` / `json` (UTF-8 read), `pdf` (pdf-parse v2 `PDFParse.getText`), `docx` (mammoth `extractRawText`). Anything else returns `kind: 'unsupported'` with empty text. Per-file budget: 32 KB of extracted text.

Client side: `lib/extract.ts` exposes `extractFile(file)` for the raw call and `runExtraction(fileId, blob, setFileExtraction)` for the fire-and-forget store-update pattern. Upload paths in `components/panels/chat-resources-panel.tsx`, `components/panels/chat.tsx` (the `+` button), and `components/panels/sources.tsx` all kick off extraction immediately after `addFile`. `processSelectedFiles` now returns `{ meta, source }[]` so callers can pair metadata with the original `File` blob.

Store: `UploadedFile` gained `extractionStatus` / `extractedText` / `extractionTruncated` / `extractedKind` fields and a `setFileExtraction(fileId, patch)` mutator. The local duplicate `UploadedFile` interface in `lib/file-utils.tsx` was removed in favour of the canonical type from `lib/types.ts`.

Chat: `app/api/chat/route.ts` accepts an extended `FileSummary` with optional `text` + `truncated`. `buildSystemPrompt` now interleaves attached files' extracted text into the system message (with file-name headers and a "treat as authoritative context" instruction), splits files into a "with-text" group and a "metadata-only" group, and applies a second-pass total budget of 96 KB across all attachments so the prompt stays in reasonable token bounds even with many big files. The previous "you do NOT have their contents" prompt is gone for files we *do* have text for.

UX polish (shipped follow-up): `components/panels/extraction-status-badge.tsx` renders the lifecycle per file row — animated spinner during `pending`, destructive "Extraction failed" pill for `failed`, muted "No text" for `unsupported`, and an amber "Truncated" indicator regardless of status when the per-file budget cut the content. Used in `chat-resources-panel.tsx` (compact) and `sources.tsx` (default size). Successful extractions render no badge — silence is the success signal.

Pending / not in scope here: OCR for scanned PDFs (would need Tesseract or a SaaS), audio/video transcription, image multimodal handling, async background extraction for large files, and a click-to-retry affordance on `failed` files. The interface is stable enough that any of these can swap in behind the same `runExtraction` / `/api/extract` boundary later.
- Decide where extraction runs: client-side (smaller deps, no infra) vs server-side route (heavier but consistent).

### 2. Reasoning / thinking token surfacing
Models that emit reasoning (DeepSeek R1, Claude thinking variants, OpenAI o1-style) currently stream their reasoning inline with the answer because we use a plain text stream. To surface them properly:

- Switch the chat route from `.toTextStreamResponse()` to a UI message stream (`createUIMessageStream` + `streamText().toUIMessageStream()`) so reasoning parts come through as distinct stream events.
- On the client, replace the raw `ReadableStream` reader with a parser that distinguishes `text` parts from `reasoning` parts.
- Render reasoning in a collapsible "Thinking…" section above the answer, similar to Claude.ai or ChatGPT, with a toggle to hide.
- Persist reasoning separately from the answer on `Message` (new `reasoning?: string`) so it survives reloads but doesn't leak into Copy / Export by default.

### 3. Backend persistence
Everything lives in `localStorage` under `hummingbird-storage` (version 3, see `lib/hooks/use-store.ts`). This blocks share links, multi-device sync, and large file storage. A full Supabase-based plan is detailed in **"Supabase persistence migration"** below.

### 4. ✅ Richer error and connectivity states *(chat shipped)*

`app/api/chat/route.ts` now categorises errors into `auth` / `rate_limit` / `invalid_model` / `provider` / `unknown` with appropriate status codes and a JSON body `{ code, message }`. The chat panel surfaces failures inline as a distinct error bubble (`components/panels/chat-message.tsx`) with **Retry**, **Change model** (opens the model picker), **Dismiss**, and a "Details" disclosure showing the error code, HTTP status, and model id. `Message` gained an optional `error: MessageError` field — see `lib/types.ts`. Error-marked messages are filtered out of the Markdown export. Aborted requests (Stop button) now drop the empty placeholder instead of leaving an "_[stopped]_" line.

Still pending for the editor routes (`app/api/ai/command/route.ts`, `app/api/ai/copilot/route.ts`): same categorisation pattern + inline rendering — left for when richer editor error UI is needed.

## Supabase persistence migration

### Context

All persistence lives in `localStorage` (`hummingbird-storage`, version 3 — see `lib/hooks/use-store.ts`). This caps the app at a single device, blocks share links, prevents server-side features (digests, scheduled tasks, RAG against attachments), and risks data loss when a user clears site data. File blobs use UploadThing today, but the metadata that ties them to workspaces still lives client-side. We want a real backend without sacrificing the current zero-friction local-first UX.

**Approach (informed by your answers):**

- **Anonymous-first, sync when signed in.** The app continues to work without auth using the existing Zustand + localStorage store. Signing in unlocks multi-device sync; sign-out reverts to local-only.
- **Email magic link only** as the sign-in method (Supabase Auth handles delivery).
- **Multi-tenant** — every row is owned by a `user_id`; Postgres RLS enforces isolation.
- **UploadThing stays for files already uploaded.** New uploads go to Supabase Storage. No data migration of existing UploadThing URLs.

This is multi-phase work. **Phase 1 is the heavy lift**; later phases extend it.

### Status

Tracks what has landed vs. what is still TODO. Updated as commits ship.

#### ✅ Shipped — scaffolding (commit `ce82aa7`)

- Dependencies: `@supabase/supabase-js`, `@supabase/ssr`
- `.env.example` documenting all required vars; `.gitignore` exemption for it
- `CLAUDE.md` "Environment Variables" section
- SQL migrations:
  - `supabase/migrations/0001_initial_schema.sql` — profiles, workspaces, conversations (incl. `document_content`), messages, files, resources, indexes
  - `supabase/migrations/0002_conversation_assets.sql` — conversation_files, artifacts, notes
  - `supabase/migrations/0003_rls_policies.sql` — RLS on every table + `on_auth_user_created` trigger
  - `supabase/storage/policies.sql` — `user-files` bucket and folder-prefix policies
- Supabase clients with defensive null when env vars are absent: `lib/supabase/{env,client,server}.ts`
- `lib/hooks/use-auth.ts` exposing `{ status: 'unconfigured' | 'loading' | 'signed-out' | 'signed-in', user, signIn, signOut }`
- `app/auth/callback/route.ts` for the magic-link code exchange
- Auth UI: `components/auth/auth-dialog.tsx`, `components/auth/account-menu.tsx` mounted in the sidebar header

Smoke-tested unconfigured: `/dashboard` 200, `/auth/callback` 307 → `/dashboard?auth_error=unconfigured`. AccountMenu renders nothing, so the UI looks identical to before.

#### ✅ Shipped — 5D notes/bookmarks *(local-only)*

`Note` type, `notes` store slice with `createNote` / `updateNoteBody` / `deleteNote` / `toggleMessageBookmark`, persisted via `partialize`. Bookmark icon on assistant messages in `components/panels/chat-message.tsx`; "Notes" tab in `components/panels/chat-resources-panel.tsx` (now tabbed Files | Notes) backed by a new `components/panels/notes-tab.tsx`. Bookmarks render with a message preview and jump-to-message scroll; deleting a message detaches its bookmark (`messageId → null`, mirroring the schema's `on delete set null`). Sync handlers for `createNote`/`updateNote`/`deleteNote` not wired yet — pending the sync layer (item 2 below).

#### ✅ Shipped — 5A reframed *(local-only)*

The `+` button on the chat input is wired as a workspace upload shortcut. Clicking it opens the file picker; selected files are validated against `FILE_SIZE_LIMIT` / `ALLOWED_EXTENSIONS` (now in `lib/upload-config.ts`, shared with `chat-resources-panel.tsx`), added to the workspace via `addFile` + `addResource`, and auto-checked in the current conversation's `selectedFileIds`. Workspace-scoped files remain the design — no new tables or store slices. The `conversation_files` table was already removed from `supabase/migrations/0002_conversation_assets.sql` and its RLS policy from `0003`. No sync work needed yet; rides on the existing `addFile` / `addResource` mutators.

#### ✅ Shipped — 5B per-conversation editor document *(local-only)*

Added `documentContent: string` to `Conversation` in `lib/types.ts`. `setConversationDocument(conversationId, content)` mutator + `useActiveConversationDocument()` selector in `lib/hooks/use-store.ts`. Store version bumped to 4 with a v3→v4 migration that backfills each conversation's `documentContent` and copies the legacy global `documentContent` into the active conversation so nothing is lost. `editorContent`, `documentContent`, `documentLastSaved` and their setters removed from the root state.

`components/panels/editor.tsx` now reads from the active conversation's doc and writes back on edit with a 500 ms debounce; switching conversations cancels any pending save and reloads the editor with the new doc. The "Sign in to open a document" empty state appears when there's no active conversation.

**Design shift:** the previous chat → editor auto-sync was removed. Sending a chat message no longer overwrites the editor. This matches the design distinction agreed in design discussion: the editor is for **active engagement** (user authors, edits, AI commands), independent from the chat conversation. If we want a "send this message to the editor" affordance later, it'll be an explicit button on the assistant message (part of the 5C work).

Sync handler for `setConversationDocument` (debounced) still pending — needs the sync layer.

#### ✅ Shipped — 5C lite assistant artifacts *(local-only)*

`Artifact` + `ArtifactKind` types in `lib/types.ts`. `artifacts` store slice with `createArtifact` / `deleteArtifact` / `togglePinArtifact` / `updateArtifactTitle` mutators; cascades on conversation delete; detaches `messageId → null` on message delete (mirrors schema). Selector `useConversationArtifacts()` returns pinned-first then newest-first.

UI:
- Archive icon on assistant messages in `components/panels/chat-message.tsx`. Click extracts fenced code blocks: 0 → saves whole message as `markdown` artifact; 1 → saves as `code`; N → saves N separate `code` artifacts. Multi-block picker UI deferred to 5C full.
- New `components/panels/artifacts-tab.tsx`; `chat-resources-panel.tsx` strip is now **Files | Notes | Artifacts** (three tabs).
- Artifact list shows kind icon, pinned star, title, language badge for code, created-at.
- Click opens a preview dialog: read-only `<pre>` of the content (no syntax highlighting in lite), inline-editable title, and **Send to editor / Copy / Pin / Delete** actions.

"Send to editor" implementation: writes the artifact content (wrapped in a code fence for code artifacts) to the active conversation's `documentContent` via `setConversationDocument`, then bumps a new `editorReloadToken` so the editor reloads even when the conversation hasn't changed. `components/panels/editor.tsx` watches the token in its load effect.

Sync handlers for `createArtifact`/`deleteArtifact`/`togglePinArtifact`/`updateArtifactTitle` still pending (sync layer).

Still pending for 5C full: auto-extraction on stream end, multi-block picker dialog on save, JSON/table/image renderers, syntax highlighting (`shiki` or similar), and binary artifact upload to Supabase Storage.

#### ⏳ TODO — Phase 1 remainder

Ordered roughly in the order they should land:

1. **Manual provisioning** *(user-side, not code)*
   - Create a Supabase project
   - Run the three migrations and `storage/policies.sql`
   - Configure auth redirect URLs (`http://localhost:3000/auth/callback` + prod)
   - Drop `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` into `.env.local`

2. **Sync layer for existing entities** — `lib/sync/sync-queue.ts`, `lib/sync/handlers.ts`, `lib/hooks/use-sync.ts`
   - Generate types: `supabase gen types typescript > lib/supabase/types.ts`
   - Queue persisted to localStorage under `hummingbird-sync-queue`
   - Retries with exponential backoff; pauses on `navigator.onLine === false`
   - Handlers for every persisted mutator listed in the Phase 1 plan above
   - `useSync()` mounted in `app/dashboard/page.tsx` diffs store snapshots and enqueues ops
   - Debounce `appendToMessage` → emit a single `updateMessage(id, fullContent)` on stream end

3. **First sign-in reconciliation flow**
   - On `SIGNED_IN`, query the cloud for the user's workspaces
   - Empty cloud → bulk-INSERT entire local state under the new `user_id`
   - Non-empty cloud → existing `AlertDialog` to choose "use cloud" (default) or "overwrite cloud with local"
   - On reconciliation: hydrate the Zustand store from the cloud, flush the queue, mark sync ready

4. **File uploads when signed in** — branch `hooks/use-upload-file.ts`
   - Signed in: `supabase.storage.from('user-files').upload(...)`, record `storage_path` + signed URL on the `files` row
   - Signed out: keep the existing UploadThing path
   - Existing UploadThing URLs keep working via `files.external_url`

5. **Conversation-related assets** *(four sub-features, each can ship independently)*
   - **~~A. Conversation-scoped file uploads~~** *(reframed + shipped local-only — see Status above)*. The `+` button on the chat input uploads to the active workspace and auto-attaches to the current conversation.
   - **~~B. Per-conversation editor document~~** *(shipped local-only — see Status above)*. Sync handler for `setConversationDocument` (debounced) still pending.
   - **~~C. Assistant-generated artifacts (lite)~~** *(shipped local-only — see Status above)*. Still pending for 5C full: auto-extraction on stream end, JSON/table/image renderers, syntax highlighting, multi-block picker UI on save, sync handlers.
   - **~~D. Notes / bookmarks~~** *(shipped local-only — see Status above)*. Sync handlers (`createNote`, `updateNote`, `deleteNote`) still pending.

6. **Verification pass** — run all 14 checklist items in the "Verification (Phase 1)" section below

#### ⏳ TODO — later phases (unchanged)

- **Phase 2** — UploadThing cutover (deprecate for new files; optional one-time migration script for existing `external_url` files)
- **Phase 3** — Realtime multi-device sync via `supabase.channel().on('postgres_changes', ...)`
- **Phase 4** — Share links: new `shares` table + `app/share/conversation/[token]/page.tsx` and `app/share/document/[token]/page.tsx`

### Architecture

```
+--------------------+        +---------------+        +-------------------+
| React UI           |  reads | Zustand store | writes | localStorage       |
| (panels/sidebars)  | <----> | (in-memory)   | <----> | (offline cache)    |
+--------------------+        +-------+-------+        +-------------------+
                                      |
                                      |  enqueues mutations
                                      v
                              +---------------+
                              |  sync queue   |  (in-memory, FIFO, retries)
                              +-------+-------+
                                      |
                                      |  flushes when authed + online
                                      v
                              +---------------+        +-------------------+
                              | Supabase JS   | <----> | Postgres + Auth   |
                              | (browser SDK) |        | + Storage         |
                              +---------------+        +-------------------+
```

**Source of truth at runtime is still the Zustand store.** Supabase is a durable mirror. This preserves the existing optimistic UI and keeps the diff to the panels small.

### Phase 1 — Auth + cloud-backed CRUD (MVP)

The work that delivers the actual feature. Everything below targets this phase unless marked otherwise.

#### Dependencies & env

- Add `@supabase/supabase-js` and `@supabase/ssr` to `package.json`.
- Add to `.env.example`:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY` *(server-only, for admin tasks; not used in Phase 1)*

#### Database schema (`supabase/migrations/0001_initial_schema.sql`)

Mirrors the existing TypeScript types in `lib/types.ts`. Messages live in their own table (not a JSONB array on `conversations`) so streaming inserts, real-time, and per-message edits don't rewrite the whole conversation row.

```sql
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz default now()
);

create table workspaces (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  pinned boolean not null default false,
  selected_file_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table messages (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  position int not null,                  -- preserves order without timestamp ties
  created_at timestamptz not null default now()
);

create table files (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  size bigint not null,
  type text not null,
  storage_path text,                       -- nullable: UploadThing legacy files have only `external_url`
  external_url text,
  uploaded_at timestamptz not null default now()
);

create table resources (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  added_at timestamptz not null default now()
);

create index on conversations (user_id, workspace_id, updated_at desc);
create index on messages (conversation_id, position);
create index on resources (workspace_id);
```

#### RLS policies (`supabase/migrations/0002_rls_policies.sql`)

Same pattern on every table — read/write only your own rows:

```sql
alter table workspaces enable row level security;
create policy "own workspaces" on workspaces
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
-- repeat for conversations, messages, files, resources, profiles
```

#### Supabase clients

- `lib/supabase/client.ts` — `createBrowserClient` from `@supabase/ssr`; singleton for the browser.
- `lib/supabase/server.ts` — `createServerClient` for API routes (Phase 2+; not needed for the queue itself).

#### Auth UI

- `components/auth/auth-dialog.tsx` — magic-link form (email input → `supabase.auth.signInWithOtp({ email })` → "Check your inbox" state). Uses the existing `Dialog` and `Input` primitives.
- `components/auth/account-menu.tsx` — small avatar/email row in the sidebar header (`components/sidebars/application.tsx`); shows "Sign in" when logged out, email + "Sign out" when logged in.
- `app/auth/callback/route.ts` — handles the magic-link redirect (`supabase.auth.exchangeCodeForSession`), then redirects back to `/dashboard`.
- `lib/hooks/use-auth.ts` — wraps `supabase.auth.onAuthStateChange`, exposes `{ user, signIn, signOut, status }`.

#### Sync layer (`lib/sync/`)

This is the part that touches the existing store. Two new files:

- `lib/sync/sync-queue.ts` — in-memory FIFO of `SyncOp` objects, processed serially. Persisted to `localStorage` under `hummingbird-sync-queue` so pending writes survive reloads. Retries with exponential backoff. Pauses when offline (uses `navigator.onLine` + `online`/`offline` listeners). No-op when there's no session.
- `lib/sync/handlers.ts` — one function per persisted mutator from `lib/hooks/use-store.ts`. Each takes the same args the mutator does and produces a `SyncOp` describing the Supabase call. Full list of mutators that need handlers (cross-referenced with `lib/hooks/use-store.ts`):
  - Workspaces: `createWorkspace`, `deleteWorkspace` (cascades), `renameWorkspace`
  - Conversations: `createConversation`, `deleteConversation`, `renameConversation`, `togglePin`, `toggleConversationFileSelection`, `clearConversationFileSelection`
  - Messages: `addMessage`, `deleteMessage`, `updateMessage`, `appendToMessage`, `truncateMessagesAfter`, `clearMessages`
  - Files: `addFile`, `removeFile`, `clearFiles`
  - Resources: `addResource`, `removeResource`
  - Misc: `setDocumentContent`, `setChatModel`, `setActiveWorkspace`, `setActiveConversation` *(last two are user-prefs; store on `profiles` if we want cross-device persistence, otherwise skip)*

For `appendToMessage` and other high-frequency calls during streaming, debounce: enqueue the final `updateMessage(id, fullContent)` when the stream ends, not every chunk.

#### Wiring sync into the store

The cleanest hook-in point is a Zustand middleware that wraps `set` — but a lighter touch works: a `useSync()` hook mounted near the root of `app/dashboard/page.tsx`. It:

1. Subscribes to relevant slices of `useStore` (workspaces, conversations, messages, files, resources, documentContent, chatModel).
2. Diffs against the previous snapshot on every change, produces sync ops, and pushes them to the queue.

This avoids modifying every mutator in `use-store.ts`. Trade-off: diffing is more work than emitting events from inside each mutator, but it leaves the store untouched and reversible.

#### First sign-in flow

When `onAuthStateChange` fires `SIGNED_IN`:

1. Query Supabase for the user's workspaces.
2. **If the cloud has zero rows:** bulk-INSERT the entire local state (workspaces, conversations, messages, files, resources) under the new `user_id`. UploadThing URLs go into `files.external_url`; `storage_path` is left null.
3. **If the cloud has rows:** prompt the user (existing `AlertDialog`) — "We found a cloud workspace. Use cloud data and discard local, or keep local and overwrite cloud?" Default to cloud (safer for multi-device).
4. After reconciliation, hydrate the Zustand store from the cloud and mark sync as ready.

On sign-out: clear the sync queue, clear the session, leave localStorage alone (so the user keeps working locally).

#### File uploads (`hooks/use-upload-file.ts`)

When signed in, replace the UploadThing call with `supabase.storage.from('user-files').upload(path, file)` and record both the storage path and a signed URL on the `files` row. When signed out, keep the existing UploadThing path. **Existing UploadThing files keep working** because they're addressed by `external_url`.

A `user-files` Storage bucket needs to be created with this policy:

```sql
create policy "own files" on storage.objects for all
  using (bucket_id = 'user-files' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'user-files' and (storage.foldername(name))[1] = auth.uid()::text);
```

Files are stored under `user-files/{user_id}/{file_id}.{ext}`.

#### API routes

`app/api/chat/route.ts` (and the editor routes) stay stateless for Phase 1. In a later phase they could read attached file content via service-role queries, which would unlock the file extraction follow-up above.

#### Critical files

New:
- `lib/supabase/client.ts`, `lib/supabase/server.ts`
- `lib/supabase/types.ts` *(generated via `supabase gen types typescript`)*
- `lib/sync/sync-queue.ts`, `lib/sync/handlers.ts`
- `lib/hooks/use-auth.ts`, `lib/hooks/use-sync.ts`
- `components/auth/auth-dialog.tsx`, `components/auth/account-menu.tsx`
- `app/auth/callback/route.ts`
- `supabase/migrations/0001_initial_schema.sql`, `supabase/migrations/0002_rls_policies.sql`
- `supabase/storage/policies.sql`

Modified (small, surgical changes):
- `package.json` — add deps
- `.env.example` — Supabase vars
- `hooks/use-upload-file.ts` — branch on auth state, fall through to UploadThing when signed out
- `components/sidebars/application.tsx` — mount `AccountMenu` in `SidebarHeader`
- `app/dashboard/page.tsx` — mount `useSync()`

Untouched (deliberate): `lib/hooks/use-store.ts`. The store stays the source of in-memory truth; the sync layer observes it from outside.

### Conversation-related assets (Phase 1, extended)

Beyond the existing entities (workspace, conversation, message, file, resource), Phase 1 introduces four new conversation-scoped concepts. Each lives in the Zustand store first (so it works offline), and the sync layer mirrors it to Supabase when signed in.

#### A. Conversation-scoped file uploads

Today every uploaded file is workspace-scoped via the `resources` join. Sometimes the user wants to drop a file *only* into one conversation without polluting the whole workspace's file list.

- **Schema** — new join table parallel to `resources`:
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
  `files` rows stay as-is — a file row can be referenced by `resources` (workspace-scoped), `conversation_files` (conversation-scoped), or both. The chat route's `files` payload (`app/api/chat/route.ts:18-22`) gets the union of workspace `selectedFileIds` + conversation-private files.
- **Store** — add `conversationFiles: { conversationId, fileId, addedAt }[]` and the mutators `addConversationFile`, `removeConversationFile`. Persisted via `partialize`.
- **UI** — `components/panels/chat-resources-panel.tsx` adds a second section "This conversation" above the existing workspace files section. The `+` button on the input bar in `components/panels/chat.tsx:344-350` (currently a no-op) becomes the upload trigger for conversation-private files.
- **Sync handlers** — `addConversationFile`, `removeConversationFile`.

#### B. Per-conversation editor document

The editor today is a single global doc (`documentContent` in the store, shared across all conversations). Several recent product moves — message → editor sync, document export — work better if each conversation owns its own doc.

- **Schema** — add columns to `conversations`:
  ```sql
  alter table conversations
    add column document_content text not null default '',
    add column document_updated_at timestamptz not null default now();
  ```
  No separate table; the doc is 1:1 with the conversation. Version history is out of scope (could go in a `conversation_document_revisions` table later).
- **Store** — replace global `documentContent` with a getter that reads `conversations[activeId].documentContent`. Add `setConversationDocument(conversationId, content)`. The global `editorContent` ephemeral field stays — that's the live cross-panel relay.
- **UI** — `components/panels/editor.tsx` reads/writes the active conversation's doc instead of the global one. The auto-sync at `components/panels/chat.tsx:115, 132` writes to the active conversation's doc. Switching conversations swaps the editor content automatically.
- **Sync handlers** — `setConversationDocument` (debounced 500 ms — editor typing is high-frequency).
- **Migration note** — on first hydration of an existing user, copy the legacy `documentContent` into the *currently active* conversation so nothing is lost.

#### C. Assistant-generated artifacts

Code blocks, generated tables, diagrams, and longer-form snippets the assistant produces. Today they live as plain text inside `Message.content`. Promoting them to first-class objects unlocks "save", "pin", "open in editor", and "render as preview".

- **Schema**:
  ```sql
  create table artifacts (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    conversation_id uuid not null references conversations(id) on delete cascade,
    message_id uuid references messages(id) on delete set null,  -- nullable: artifacts can outlive their source message
    kind text not null check (kind in ('code','markdown','image','table','json','other')),
    language text,                  -- e.g. 'tsx', 'python' — nullable
    title text,
    content text,                   -- inline text content (code, md, json, table CSV)
    storage_path text,              -- for binary artifacts (images), null for text
    pinned boolean not null default false,
    created_at timestamptz not null default now()
  );
  create index on artifacts (conversation_id, created_at desc);
  ```
- **Store** — `artifacts: Artifact[]` slice; mutators `createArtifact`, `deleteArtifact`, `togglePinArtifact`, `updateArtifactTitle`. Persisted.
- **Creation paths**:
  - Manual: a "Save as artifact" button on assistant messages in `components/panels/chat-message.tsx` (next to Copy / Regenerate). Detects fenced code blocks in the message content; if multiple, opens a small picker.
  - Automatic (Phase 1b, optional): post-stream pass that extracts every fenced code block of >5 lines into an artifact. Defer if it bloats Phase 1.
- **UI** — new `components/panels/artifacts-panel.tsx` (a tab in `chat-resources-panel.tsx` or a new sidebar entry). Lists artifacts for the active conversation with kind icon, title, pinned flag, click-to-preview. "Open in editor" sets the editor content.
- **Sync handlers** — `createArtifact`, `deleteArtifact`, `togglePinArtifact`, `updateArtifactTitle`. Binary artifacts (images) follow the same Storage path scheme as files: `user-files/{user_id}/artifacts/{artifact_id}.{ext}`.

#### D. Per-conversation notes / bookmarks

User-authored snippets attached to a conversation. Two modes:
- **Conversation note** — free-form scratchpad (`message_id` null).
- **Message bookmark** — a saved pointer to one message with optional commentary (`message_id` set).

- **Schema**:
  ```sql
  create table notes (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    conversation_id uuid not null references conversations(id) on delete cascade,
    message_id uuid references messages(id) on delete set null,
    body text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create index on notes (conversation_id, created_at desc);
  ```
- **Store** — `notes: Note[]` slice; `createNote`, `updateNote`, `deleteNote`.
- **UI**:
  - A bookmark icon on each assistant message in `chat-message.tsx` toggles a `Note { message_id }`.
  - A "Notes" tab in the right-side panel lists all notes for the conversation. Bookmarks render as link cards (click jumps to the message).
- **Sync handlers** — `createNote`, `updateNote`, `deleteNote`.

#### Updated handlers list (Phase 1)

Adds to the original handler list in `lib/sync/handlers.ts`:

- `addConversationFile`, `removeConversationFile`
- `setConversationDocument` *(debounced)*
- `createArtifact`, `deleteArtifact`, `togglePinArtifact`, `updateArtifactTitle`
- `createNote`, `updateNote`, `deleteNote`

#### Updated verification (Phase 1)

Append to the existing checklist:

11. **Conversation-scoped file** — upload a file via the chat input's `+` button; verify it appears in the "This conversation" section, the chat API receives it in `files`, and a row exists in `conversation_files`.
12. **Per-conversation editor doc** — type in the editor, switch conversations, switch back; content reappears. Verify `conversations.document_content` updates and is debounced (no row write per keystroke).
13. **Artifact creation** — send a prompt that returns a code block, click "Save as artifact"; verify a row in `artifacts` with kind=`code` and the language detected.
14. **Note + bookmark** — bookmark an assistant message; verify a `notes` row with `message_id` set, and that deleting the message nulls (not cascades) the bookmark.

### Phase 2 — File storage cutover (follow-on)

Once Phase 1 is stable, deprecate UploadThing for new files entirely and (optionally) write a one-time migration script that downloads each `external_url` and re-uploads to Supabase Storage. Not in scope for Phase 1.

### Phase 3 — Realtime multi-device sync (follow-on)

Subscribe to Postgres changes via `supabase.channel().on('postgres_changes', ...)` for the signed-in user's `messages`, `conversations`, `workspaces` rows and reconcile into the store. Requires a "last-writer-wins" rule on most tables and careful handling of `editorContent` (probably use a Yjs-style CRDT or just lock the doc to the active client). Out of scope for Phase 1.

### Phase 4 — Share links (follow-on)

Add a `shares` table with `(token, conversation_id|document_id, revoked_at)`. New routes `app/share/conversation/[token]/page.tsx` and `app/share/document/[token]/page.tsx` server-render a read-only view bypassing RLS via a service-role server-side query keyed by token. Out of scope for Phase 1.

### Verification (Phase 1)

End-to-end test plan, manually walked through after deployment to a Supabase project:

1. **Schema applied** — `supabase db push` produces all five tables with RLS enabled. `select * from pg_policies where tablename in ('workspaces','conversations','messages','files','resources');` returns the expected policies.
2. **Anonymous still works** — clear cookies + localStorage, open `/dashboard`. The demo workspace appears, you can create conversations and send messages, nothing hits Supabase (Network tab confirms).
3. **Sign-in roundtrip** — open the auth dialog, request a magic link, click it from the inbox, land on `/dashboard` signed in.
4. **First sign-in upload** — create local state pre-signin, sign in, verify rows appear in `workspaces`/`conversations`/`messages` for that `user_id`. Verify another user signing in sees nothing.
5. **Multi-device read** — sign in on a second browser, confirm conversations and messages load from the cloud and the local demo doesn't overwrite them.
6. **RLS sanity** — in the SQL editor, attempt `select * from messages where user_id <> auth.uid()` as that user; verify zero rows returned.
7. **Offline behavior** — DevTools → Offline, send a message, refresh — message persists locally. Go online; the queue flushes within seconds; row appears in Supabase.
8. **File upload signed-in** — upload a PDF; confirm the row in `files` has a `storage_path` (not just `external_url`) and the blob is visible in the Storage bucket under `user-files/{user_id}/`.
9. **File upload signed-out** — sign out, upload a PDF; confirm the row's URL is an UploadThing one.
10. **Sign-out leaves local intact** — sign out, refresh, demo workspace and any local conversations are still present in the UI (because localStorage wasn't cleared).
