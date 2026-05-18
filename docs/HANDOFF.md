# Handoff — `claude/dev-followups`

A working-state record for the next agent picking this up locally. Read in
one sitting; everything you need to be productive is here or one hop away
in `docs/`.

## Where you are

- **Repo:** Hummingbird chat assistant (Next.js 16 App Router, React 19,
  Zustand, Plate.js editor, Tailwind v4). See `CLAUDE.md` for the full
  stack reference.
- **Branch:** `claude/dev-followups`, branched from `dev` at the merge of
  PR #1 (the big chat-overhaul). Run `git log --oneline dev..HEAD` for
  the chronological narrative, and `git status` to see whether the
  working tree is clean before you start.
- **What you're picking up:** Phase 1 sync layer has now **shipped** on
  this branch (see "Supabase Phase 1 — sync layer" below). The main
  remaining work is verification against a real Supabase project + the
  small follow-ups in the "Open / next" table further down.

## What's already shipped on this branch

Grouped, newest first. Every commit message is detailed enough to stand
alone — `git log --oneline dev..HEAD` lists them in order.

### Chat experience overhaul
- **Reasoning/thinking tokens** (`090bf55`): chat route now emits typed
  SSE frames (`text` / `reasoning` / `error` / `done` / `suggestions`).
  Reasoning renders in a collapsible "Thinking…" block above the answer.
- **Streaming markdown in chat bubbles** (`eebe210`): assistant messages
  render via `<MarkdownPreview>` (uses `marked`, already a transitive
  dep) with a `.markdown-chat-bubble` CSS variant that fixes the
  code-block-blends-into-bubble issue.
- **Suggested follow-up questions** (`66712f1`): after each successful
  assistant turn, the server runs a separate `generateText()` against
  Gemini Flash and emits 3 prompts as a `suggestions` SSE frame. Chips
  render only on the most recent non-error assistant message.
- **Image chips on past messages** (`558aad4`): user messages snapshot
  `attachedFileIds` at send time; the bubble renders 56×56 thumbnails
  for images + filename chips for other files, with a full-size preview
  dialog. Deleted files render as a dashed "Deleted attachment"
  placeholder.

### Workspaces & files
- **Vision image input** (`c9e2932`): image uploads (≤2 MB) read locally
  as base64 data URLs (`FileReader`), stored on `UploadedFile.imageDataUrl`,
  forwarded as multimodal `image` content parts on the last user message
  only. Supports Claude Sonnet, GPT-4o, Gemini 2.5 Pro.
- **Per-workspace system prompts** (`9683211`): `Workspace.systemPrompt`,
  always-visible textarea on each workspace card, server-side prepended
  in `buildSystemPrompt`. Persist version bumped to 5 with a backfill
  migration.
- **Auto-summarise on file upload** (`1eaae99`): after extraction ≥500
  chars, `/api/summarize` runs in the background and stores
  `summary` + `keyTopics[]` on the file. Key topics inline in the chat
  resources panel; full summary in the sources hover card.

### Artifacts
- **5C lite + full** (already on `dev`, see PR #1): manual save, multi-
  block picker, JSON kind with `Braces` icon + pretty-print, lazy-loaded
  syntax highlighting via `highlight.js/lib/common`.
- **Markdown rendering for `kind: 'markdown'` artifacts** (`1c175c8`):
  proper GFM tables, headings, lists, fenced code via marked. Drops the
  earlier raw-pre fallback. New `components/markdown-preview.css` with a
  default + chat-bubble variant.

### Editor
- **Per-conversation editor doc** (already on `dev`): each `Conversation`
  owns its `documentContent`. The editor reads + writes the active
  conversation's doc, debounced 500ms. Switching cancels pending saves.
- **Save indicator** (`e4a2b10`): "Saving…" spinner during debounce,
  "Saved" check for 1.5s after, then idle.
- **Editor AI failures surface as toasts** (`b7300fc`): the editor's
  `use-chat.ts` wraps fetch; non-auth errors with the new
  `{code, message}` shape are surfaced via `toast.error`. The auth-error
  path still falls through to the demo mock so the editor works without
  an API key.

### Onboarding & UX polish
- **Welcome card + help popover** (`5d69a9a`): empty conversations render
  `<EmptyChatWelcome>` (feature cards + click-to-prefill suggestion chips).
  The seeded demo conversation starts empty (no stale "Hi! I am testing"
  messages). A `?` button in the sidebar header opens a shortcuts +
  tips popover.
- **Conversation TL;DR** (`56983b4`): "Summarise" entry on each
  conversation popover → dialog with overview + key points + decisions.
  Save as artifact / Send to editor / Copy actions.

### Bundle / correctness / observability
- **Dynamic-imported editor** (`e4a2b10`): `EditorPanel` now loads via
  `next/dynamic` with `ssr: false`. Plate.js + plugins (~200 KB) are
  out of the initial chunk on chat-only sessions.
- **Extraction failure toasts** (`e4a2b10`): silent failures now surface
  via toast in addition to the status badge.
- **API input validation** (`e4a2b10`): `lib/api-schemas.ts` has Zod
  schemas for `/api/chat` and `/api/ai/copilot`. Malformed bodies →
  400 `{ code: 'invalid_request', message }`. Skipped
  `/api/ai/command` — its `ctx` payload is opaque Plate internals.

### Supabase Phase 1 — sync layer **(shipped this session)**

The scaffolding from PR #1 is now backed by a working sync layer.

- `lib/supabase/types.ts` — hand-rolled `Database` type covering
  migrations 0001 + 0002 + **0004**. Make `client.ts` / `server.ts`
  generic over `Database`; exports `AppSupabaseClient`.
- `lib/sync/sync-queue.ts` — persistent FIFO queue
  (`hummingbird-sync-queue` in localStorage). Exponential backoff,
  `online`/`offline` aware, SQLSTATE-aware (23/22/42/PGRST codes drop;
  others retry). Public API: `enqueue`, `configureSync`,
  `pendingOpCount`, `whenDrained(timeoutMs)`, `resetSyncQueue`.
- `lib/sync/handlers.ts` — pure diff producers per entity. Writes
  reasoning / error / attachedFileIds / suggestions on messages; file
  extraction metadata; workspace systemPrompt. Skips per-chunk message
  diffs when `isTyping === true` (final sweep fires when typing flips
  off).
- `lib/sync/reconcile.ts` — `fetchCloudSnapshot`, `bulkUploadLocalState`,
  `applyCloudSnapshot`. The apply path seeds the sync diff baseline via
  `setSyncSnapshot()` **before** `useStore.setState`, so the queue
  doesn't re-upload what we just downloaded.
- `lib/hooks/use-sync.ts` — `useSync()` subscribes to store + diffs +
  enqueues. Exports `seedSyncSnapshot()` (reads current state) and
  `setSyncSnapshot(snapshot)` (synchronous seed before setState).
- `lib/hooks/use-reconcile.ts` — first-time prompt + silent pull on
  refresh + `online` re-pull. Reconciled-users marker persisted to
  localStorage as `hummingbird-reconciled-users`, so the dialog only
  ever fires once per user per browser. **Depend on `user.id` (stable
  string), not `user` (changing object)** — otherwise
  `onAuthStateChange` reposting the same session tears down the
  in-flight pull. Bug fixed this session; don't regress.
- `components/auth/reconcile-dialog.tsx` — AlertDialog for first-time
  cloud-vs-local choice.
- `app/dashboard/page.tsx` — mounts `<SyncMount/>` and `<ReconcileMount/>`.
- `hooks/use-upload-file.ts` — branches: signed-in → Supabase Storage
  (`user-files/{user_id}/{file_id}.{ext}`, 1-year signed URL);
  signed-out / failure → UploadThing (existing path).

### Migration 0004 — runtime metadata columns

`supabase/migrations/0004_runtime_metadata.sql` adds the columns that
local TS types carried but 0001/0002 omitted (idempotent `add column
if not exists`). Run this in SQL editor before relying on field
preservation across refresh / cross-device:

- `messages.reasoning text`, `error jsonb`, `attached_file_ids uuid[]`,
  `suggestions text[]`
- `files.extraction_status` (CHECK-constrained), `extracted_text`,
  `extraction_truncated`, `extracted_kind`, `image_data_url`, `summary`,
  `key_topics text[]`
- `workspaces.system_prompt`

`image_data_url` is multi-MB base64. Acceptable for Phase 1; Phase 2
moves binary blobs to Storage.

### Auth swap — magic link → email + password

- `signIn(email, password)` via `supabase.auth.signInWithPassword`.
- `components/auth/auth-dialog.tsx` rebuilt with two fields + inline
  error. No magic-link UI; no sign-up surface (provision users from
  the Supabase dashboard).
- `/auth/callback` route is kept for future email-confirmation /
  OAuth.

### Sidebar restructure

- AccountMenu, HelpPopover, ThemeToggle moved from header → footer
  (`SidebarFooter`).
- Help + theme hidden in icon-collapsed mode (`group-data-[collapsible=icon]:hidden`);
  AccountMenu remains as an avatar icon only.
- Removed `className="z-100"` from `<Sidebar>` — popovers/dropdowns
  default to z-50 and were rendering *behind* the sidebar.

### Chat UI tweaks

- Avatars removed (user + assistant + typing indicator). Sender ID is
  alignment + fill only.
- New CSS tokens `--user-bubble` / `--user-bubble-foreground` in
  `app/globals.css` (light + dark). User bubble is a half-step from
  `--secondary`; same text colour as the assistant.
- Assistant "box" removed: no bg, no padding, no radius on assistant
  messages. User keeps the bubble.
- Message column widened from `max-w-[70%]` to `max-w-[90%]`.
- `ReasoningBlock` rewritten: `max-h-[40vh] overflow-y-auto`,
  `MarkdownPreview` for the body, live pulse during stream, hover
  copy button, line-count badge. Timing badge was prototyped, then
  removed at user request.

### Misc

- Default chat model → `deepseek/deepseek-v4-flash` (`lib/models.ts`).
- PDF extraction fix: `next.config.ts` now sets
  `serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'mammoth']` so
  Node loads them from `node_modules` and `pdfjs-dist` can find its
  worker module.
- Build/TS: surgical `@ts-expect-error` on AI SDK v5 mismatches in
  `app/api/ai/command/route.ts`; typed callback in
  `block-placeholder-kit.tsx`; `<TooltipProvider>` wraps
  `/editor/page.tsx`.

### Diagnostic logs to clean up

There are `[sync]` prefixed `console.log` calls in `use-reconcile.ts`
and `lib/sync/reconcile.ts` that were added to debug the
in-flight-cancel bug. The bug is fixed; the logs are still there as
breadcrumbs. Either gate them behind a `DEBUG_SYNC` env var or strip
them outright before merging.

## What to do first — verification + small follow-ups

Phase 1 is code-complete. The remaining work is real-world
verification + a few small things flagged below.

### Architecture

Source of truth at runtime stays the Zustand store. Supabase is a
durable mirror. A sync queue observes store mutations and flushes ops
to Supabase in the background; failures retry with exponential backoff
and persist across reloads.

```
React UI → Zustand store ↔ localStorage (offline cache)
              ↓
        sync queue (in-memory FIFO + localStorage persist)
              ↓
       Supabase JS → Postgres + Auth + Storage
```

### Implementation status — all done

| Item | Status |
|---|---|
| `lib/supabase/types.ts` (hand-rolled `Database`) | ✅ |
| `lib/sync/sync-queue.ts` + `whenDrained()` | ✅ |
| `lib/sync/handlers.ts` diff producers | ✅ (writes the 0004 fields too) |
| `lib/hooks/use-sync.ts` | ✅ — `setSyncSnapshot` for atomic seed-before-setState |
| `lib/sync/reconcile.ts` + `lib/hooks/use-reconcile.ts` | ✅ — first-time prompt + silent refresh-pull + `online` re-pull + reconciled-users set |
| `components/auth/reconcile-dialog.tsx` | ✅ |
| `app/dashboard/page.tsx` — mount `useSync()` + `useReconcile()` | ✅ |
| `hooks/use-upload-file.ts` — Storage on signed-in | ✅ (1-year signed URL) |
| `0004` migration: runtime metadata columns | ✅ SQL committed; **user still needs to run it against the project** |

### Critical files (unchanged from PR #1 plan, plus 0004)

New since PR #1:
- `lib/supabase/types.ts`
- `lib/sync/sync-queue.ts`, `lib/sync/handlers.ts`, `lib/sync/reconcile.ts`
- `lib/hooks/use-sync.ts`, `lib/hooks/use-reconcile.ts`
- `components/auth/reconcile-dialog.tsx`
- `supabase/migrations/0004_runtime_metadata.sql`

Modified:
- `app/dashboard/page.tsx` — mounts `<SyncMount/>` and `<ReconcileMount/>`
- `hooks/use-upload-file.ts` — auth-state branch
- `components/auth/auth-dialog.tsx`, `lib/hooks/use-auth.ts` — password sign-in
- `components/sidebars/application.tsx` — sidebar footer rearrange
- `next.config.ts` — `serverExternalPackages` for PDF/DOCX extractors

Deliberately untouched: `lib/hooks/use-store.ts`. The store stays the
source of in-memory truth; the sync layer observes from outside.

### Verification — still TODO

These are the steps the next agent (or you, after running 0004) should
walk through:

1. **Anonymous still works** — clear cookies + localStorage, demo
   workspace appears, can chat without network calls to Supabase.
2. **First sign-in upload** — create local state pre-signin, sign in,
   verify rows appear in `workspaces` / `conversations` / `messages`
   under your `user_id`.
3. **Multi-device read** — sign in on a second browser, confirm
   conversations load from the cloud.
4. **RLS sanity** — in the SQL editor, `select * from messages where
   user_id <> auth.uid()` returns zero rows.
5. **Offline behaviour** — DevTools → Offline → send a message →
   refresh → message persists locally; go online → queue flushes
   within seconds → row appears in Supabase.
6. **Sign-out leaves local intact** — sign out, refresh, local data
   still present.
7. **Refresh re-syncs (new)** — delete a row in Supabase SQL editor,
   refresh dashboard, the row should disappear locally (silent pull).

## Other open items

If sync is blocked for any reason, here's the queue of pickable items
that don't need infra (full list with effort estimates in the chat
log + `docs/ROADMAP.md`):

- **Mobile layout** — `chat-resources-panel.tsx:76` is `hidden lg:flex`
  (panels disappear on phones); stale `mobile` branch on origin
  suggests this was planned.
- **Tests** — zero coverage. Start with store-reducer tests + one
  chat-panel smoke test (Vitest + RTL).
- **Slash commands / prompt templates** — `/summarize`, `/translate`,
  custom templates. Command palette infra in `components/command-palette.tsx`
  is ready to extend.
- **Cross-workspace / ⌘F message search** — sidebar search is title +
  first-100-messages within active workspace only.
- **Inline citations to source files** — prompt the model to cite by
  `[filename]`; client parser turns brackets into clickable refs.
  Halfway to RAG without retrieval.
- **Accessibility pass** — <20 aria-labels app-wide.
- **Voice input + TTS playback** — Web Speech API; no infra.

## Conventions used so far

- **Commit style** — descriptive subject, multi-paragraph body
  explaining *why* (not just what). Pattern:
  `<scope>: short title\n\nWhy this matters / what changed / pointers
  to gotchas`.
- **Scope discipline** — each commit ships one coherent change. If
  something turns out to need a refactor mid-commit, that refactor
  becomes its own commit.
- **No new deps unless necessary** — almost every feature on this
  branch reused something already installed (marked, highlight.js,
  zod). Check `node_modules` before `bun add`.
- **Verification expectations** — every commit type-checks
  (`bunx tsc --noEmit`) and dev-boots (`bun dev` + curl `/dashboard`
  for 200). Interactive UI flows that can't be driven from the harness
  are explicitly flagged in the commit body for human verification.
- **Plan files** — when shipping a 200+ line batch, write a plan to
  `docs/PLAN-*.md` before coding (see `docs/PLAN-chat-experience-batch.md`).

## Gotchas

- **AI SDK v5 type mismatches in `app/api/ai/command/route.ts`** — these
  used to block `bun run build` (despite the original handoff saying
  they didn't). Suppressed in this session with `@ts-expect-error`
  directives at the offending lines. If the AI SDK fixes the typing,
  TS will error on the now-unused directives and prompt removal.

- **TS closure narrowing** in `components/panels/chat.tsx`'s
  `callChatAPI` — the SSE loop uses an `ensurePlaceholder` closure
  that mutates `let placeholder` from outer scope. TypeScript can't
  narrow through that, so the catch block + the `suggestions`
  handler cast back to `Message | null` explicitly. If you touch that
  function, expect to need those casts (or restructure with a
  `{ current: Message | null }` ref pattern).

- **AI SDK `ModelMessage` vs. our Zod schema** — Zod validates the
  outer structural shape (role + content union including multimodal
  parts). The AI SDK has tighter inner discriminants we don't fully
  duplicate. `app/api/chat/route.ts:130` and `:257` cast back to
  `ModelMessage[]` at the call site. Don't worry about it unless the
  AI SDK changes its public type.

- **localStorage is a ticking timer**. With extracted text, image
  data URLs (≤2 MB each), and full message history all serialized into
  one key (`hummingbird-storage`), the 5-10 MB quota gets uncomfortable
  faster than you'd expect. The sync layer is the real fix. Until
  then, the audit in `docs/ROADMAP.md` flags this as a known constraint.

- **Auth events fire multiple times** — `onAuthStateChange` emits
  `INITIAL_SESSION`, then sometimes `TOKEN_REFRESHED`, each time
  calling `setUser` and producing a NEW `user` object reference. Any
  hook depending on `[authStatus, user]` will re-run its cleanup and
  cancel in-flight async work. **Always depend on `user.id` (stable
  string)**. `useReconcile` and `useSync` have been switched; if you
  add another auth-gated hook, follow that pattern.

- **`[sync]` console logs** are still in `use-reconcile.ts` and
  `lib/sync/reconcile.ts` from this session's debug pass. Strip or
  gate them before merge.

- **`pdf-parse@2` + Turbopack** — the package wraps `pdfjs-dist` which
  dynamically imports its worker. Turbopack bundles it and breaks
  the relative resolution. Fix is `serverExternalPackages` in
  `next.config.ts`. Mammoth (DOCX) needs the same.

## How to start

1. Apply `supabase/migrations/0004_runtime_metadata.sql` in the SQL
   editor against your project. Without it, sync writes will silently
   drop the new fields and refresh will lose them.
2. In the Supabase Auth dashboard: create a user (email + password)
   to test sign-in. There's no sign-up UI in the app.
3. Walk through the 7-step verification above. Open the network tab
   and watch `bsapthtfvflybeouyfqc.supabase.co` REST calls; that's
   the queue flushing.
4. Strip the `[sync]` debug logs once you've confirmed the silent
   refresh-pull works end-to-end.

## Where to look for context if you get stuck

- `docs/ROADMAP.md` — the long-term roadmap, including the Phase 1
  plan in full
- `docs/SUPABASE_SETUP.md` — what the user did to set up
- `docs/PLAN-chat-experience-batch.md` — example of a recent
  three-feature plan document
- `CLAUDE.md` — tech-stack and architectural conventions
- `git log --oneline dev..HEAD` — chronological narrative of what
  shipped on this branch
- Individual commit messages — every one has a *why*, not just a what

Good luck.
