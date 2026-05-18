# Handoff — `claude/dev-followups`

A working-state record for the next agent picking this up locally. Read in
one sitting; everything you need to be productive is here or one hop away
in `docs/`.

## Where you are

- **Repo:** Hummingbird chat assistant (Next.js 16 App Router, React 19,
  Zustand, Plate.js editor, Tailwind v4). See `CLAUDE.md` for the full
  stack reference.
- **Branch:** `claude/dev-followups`, branched from `dev` at the merge of
  PR #1 (the big chat-overhaul). 14 commits ahead of `dev`. Working tree
  clean. Already pushed.
- **What you're picking up:** The Supabase **sync layer** is the highest-
  value piece of work currently blocked. Everything needed is documented;
  you just need a provisioned Supabase project to verify against.

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

## What's already in place for the Supabase work

Scaffolding shipped earlier (already on `dev`, see PR #1) — code is
ready, just needs a project to talk to:

- **Schema** — `supabase/migrations/0001_initial_schema.sql`,
  `0002_conversation_assets.sql`, `0003_rls_policies.sql`
- **Storage bucket policies** — `supabase/storage/policies.sql`
- **Defensive clients** — `lib/supabase/{env,client,server}.ts` return
  `null` when env vars are absent so nothing crashes pre-setup
- **Auth UI** — `components/auth/auth-dialog.tsx` + `account-menu.tsx`
  (sidebar header); renders nothing when `NEXT_PUBLIC_SUPABASE_URL`
  isn't set
- **Magic-link callback** — `app/auth/callback/route.ts`
- **`useAuth` hook** — `lib/hooks/use-auth.ts` exposes
  `status: 'unconfigured' | 'loading' | 'signed-out' | 'signed-in'`,
  `user`, `signIn`, `signOut`

The local user is following **`docs/SUPABASE_SETUP.md`** to provision
their project + run the migrations + set `.env.local`. When they're
done, the `<AccountMenu>` Sign-in button appears in the sidebar
header. That's the signal you're ready to start.

## What to do first — the sync layer

This is the highest-leverage remaining work. Plan is in
**`docs/ROADMAP.md`** under "Supabase persistence migration → Phase 1".
Summarised here so you have it inline:

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

### Implementation order

1. **Generated DB types** — `bunx supabase gen types typescript
   --project-id <id> > lib/supabase/types.ts`. Then `lib/supabase/client.ts`
   and `server.ts` should be generic over `Database`.

2. **`lib/sync/sync-queue.ts`** — in-memory FIFO of `SyncOp` objects.
   Persisted to `localStorage` under `hummingbird-sync-queue` so
   pending writes survive reloads. Retries with exponential backoff.
   Pauses when `!navigator.onLine`. No-ops when there's no session.

3. **`lib/sync/handlers.ts`** — one handler per persisted mutator. Full
   list (cross-reference `lib/hooks/use-store.ts`):
   - Workspaces: `createWorkspace`, `deleteWorkspace` (cascades),
     `renameWorkspace`, `setWorkspaceSystemPrompt`
   - Conversations: `createConversation`, `deleteConversation`,
     `renameConversation`, `togglePin`,
     `toggleConversationFileSelection`,
     `clearConversationFileSelection`, `setConversationDocument` (debounced)
   - Messages: `addMessage`, `deleteMessage`, `updateMessage`,
     `appendToMessage` (debounce — emit final `updateMessage` on
     stream end, not every chunk), `truncateMessagesAfter`,
     `clearMessages`, `setMessageError`, `setMessageSuggestions`,
     `appendToMessageReasoning` (same debounce treatment)
   - Files: `addFile`, `removeFile`, `clearFiles`,
     `setFileExtraction` (multiple patch shapes)
   - Resources: `addResource`, `removeResource`
   - Notes: `createNote`, `updateNoteBody`, `deleteNote`,
     `toggleMessageBookmark`
   - Artifacts: `createArtifact`, `deleteArtifact`,
     `togglePinArtifact`, `updateArtifactTitle`
   - Misc: `setChatModel`, `setActiveWorkspace`, `setActiveConversation`
     (last two are user-prefs; consider putting on `profiles` or
     skipping)

4. **`lib/hooks/use-sync.ts`** — mounted once near the root of
   `app/dashboard/page.tsx`. Subscribes to relevant slices of `useStore`
   via Zustand selectors. Diffs against the previous snapshot on every
   change, produces `SyncOp`s, pushes to the queue. Avoids modifying
   every mutator in `use-store.ts` (reversible if we need to back out).

5. **First-sign-in reconciliation**. When `onAuthStateChange` fires
   `SIGNED_IN`:
   - Query Supabase for the user's workspaces.
   - **Empty cloud** → bulk-INSERT entire local state under the new
     `user_id`. UploadThing URLs go into `files.external_url`;
     `storage_path` stays null.
   - **Non-empty cloud** → existing `AlertDialog` to choose "use cloud
     and discard local" (default — safer for multi-device) or
     "overwrite cloud with local".
   - After reconciliation, hydrate Zustand from the cloud and mark
     sync ready.

6. **File uploads when signed in**. Branch `hooks/use-upload-file.ts`:
   signed in → `supabase.storage.from('user-files').upload(path, file)`,
   record `storage_path` + signed URL on the `files` row. Signed out →
   keep existing UploadThing path. Existing UploadThing files keep
   working via `files.external_url`. Path scheme:
   `user-files/{user_id}/{file_id}.{ext}`.

### Critical files

New:
- `lib/supabase/types.ts` (generated)
- `lib/sync/sync-queue.ts`, `lib/sync/handlers.ts`
- `lib/hooks/use-sync.ts`

Modified (small, surgical):
- `app/dashboard/page.tsx` — mount `useSync()`
- `hooks/use-upload-file.ts` — branch on auth state, fall through to
  UploadThing when signed out
- `components/sidebars/application.tsx` — already mounts `AccountMenu`

Deliberately untouched: `lib/hooks/use-store.ts`. The store stays the
source of in-memory truth; the sync layer observes from outside.

### Verification

End-to-end smoke test, manually after the layer ships:

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

- **Pre-existing TS errors in `app/api/ai/command/route.ts`** at
  lines 76, 78, 192, 194, 211, 213, 264, 266, 276, 278. AI SDK
  version mismatch (`output: Output.choice/array` and `partialOutputStream`
  changed shape). The route still works at runtime via turbopack's
  looser checking, but `bunx tsc --noEmit` will complain. **Ignore
  these unless you're refactoring that file**. Filter with
  `grep -v "app/api/ai/command/route\.ts\|block-placeholder-kit"` when
  reading typecheck output.

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

- **Pre-existing AI SDK overload errors don't block compile**. They
  show up under `bunx tsc --noEmit` but Next.js dev/build runs fine.
  Don't get distracted trying to fix them — they're unrelated to
  current work and would need an AI SDK type-investigation of their
  own.

## How to start

1. Confirm the user finished `docs/SUPABASE_SETUP.md`. The
   `AccountMenu` should show a **Sign in** button in the sidebar
   header. If not, the env vars aren't picked up — restart `bun dev`.
2. Sign in with magic link. Verify a row appears in
   `public.profiles` via the SQL Editor.
3. Generate DB types:
   `bunx supabase gen types typescript --project-id <id> > lib/supabase/types.ts`
4. Start with `lib/sync/sync-queue.ts`. Use the implementation order
   above. Each numbered piece can be its own commit.
5. Don't open a PR until the full Phase 1 lands and the 6-step
   verification passes against the real project.

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
