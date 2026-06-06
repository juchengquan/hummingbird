# Plan: Small follow-ups batch

Status: **planning** — pick one or several at a time, each ships
independently.

Polish and deferred-sub-task items that surfaced from larger features
but didn't deserve their own plan. Each is a half-day or less. They
live here together so they're easy to find and discrete enough to be
worked through in any order.

Pick by leverage on a given day, not by section order. Each item
has its own **Approach**, **Verification**, **Out of scope** so you
can implement one in isolation without re-reading the rest.

---

## ~~1. Cross-device sync of `Message.generatedImages` metadata~~ ✅ shipped ([#45](https://github.com/juchengquan/hummingbird/pull/45))

Migration `0010_message_generated_images.sql` + `diffMessages`
upsert + reconcile hydration with a defensive boundary parser.
Original notes kept below for reference.

**Why.** Phase 1 image-gen storage shipped the bytes to Supabase
Storage with a `storagePath` on `GeneratedImage`, but the message
row's `generatedImages` JSON is still excluded from the sync handler
(`lib/client/sync/handlers.ts` — see the comment above `diffMessages`).
A user generating an image on device A doesn't see it on device B.
The bytes are durable; only the metadata row lags.

**Approach.**

- Add a `generated_images jsonb` column to `messages` (idempotent
  migration `00XX_message_generated_images.sql`).
- Update the supabase types in `lib/shared/supabase/types.ts` to
  reflect the new column.
- In `lib/client/sync/handlers.ts`:
  - Drop `generatedImages` from the "stays local" list in the
    file-header comment.
  - Add `generated_images: m.generatedImages ?? null` to the upsert
    payload in `diffMessages`.
  - Add a `JSON.stringify`-based equality check in `messageEquals`
    so the diff doesn't fire on no-ops.
- In `lib/client/sync/reconcile.ts`:
  - Rehydrate `generatedImages` from the new column. URLs are
    Supabase signed URLs (already long-lived) — no re-signing
    needed at this layer.
  - Type-cast guard the JSON to `GeneratedImage[]` with a Zod
    schema or a hand-written shape check.

**Verification.**

- Sign in on device A, generate an image, wait for sync. On device B,
  reload the conversation; the image renders.
- Data-URL fallback path (anonymous + Supabase configured) still
  works locally — the column stays null in that case but the local
  state has the data URL, which roundtrips through localStorage.
- RLS sanity: the `generated_images` column inherits the existing
  `messages` RLS policy, so no policy change is needed.

**Out of scope.** Lazy signed-URL re-sign on render (item 4 below).

---

## 2. Accurate per-family token counting

**Why.** `lib/shared/tokens.ts:estimateTokens` uses a chars/4
heuristic. Across English prose it's within ±20%, but code/JSON
heavy chats undercount by 30–50%. The compression action's
"Compress" button decides when to surface based on this estimate;
accuracy matters more now that compression depends on it.

**Approach.**

- Add `js-tiktoken` as a dep (~120 KB raw, gzip-friendly). It bundles
  OpenAI's encoders (`cl100k_base` / `o200k_base`).
- Extend `lib/shared/models.ts:CHAT_MODELS` entries with an optional
  `tokenizer: 'tiktoken-cl100k' | 'tiktoken-o200k' | 'heuristic'`.
  Default `'heuristic'`. Fill in OpenAI + Anthropic models (Claude's
  tokenizer is close to `cl100k_base` — within a few %).
- Rewrite `estimateTokens(text, modelId?)` to pick the encoder by
  model id. Falls back to the chars/4 heuristic for anything
  unknown.
- `estimateConversationTokens(messages, modelId?)` threads `modelId`
  through; the meter component (`context-meter.tsx`) already has
  the model id available — just pass it.
- Memoise the encoder per model id (one-time cost; ~50 ms first
  call, microseconds after).

**Verification.**

- Drop a code-heavy message (e.g. a 200-line TS snippet) into a chat
  using GPT-4o. The meter now shows ~1.5x the count it did before.
- Switch to a model with `tokenizer: 'heuristic'`; the meter reverts
  to chars/4 (verify by toggling the model and watching the chip).
- New `lib/shared/tokens.test.ts` covers: encoder selection, fallback
  to heuristic, conservation across roles (assistant reasoning
  still counted).

**Out of scope.** Per-Gemini / per-DeepSeek encoders — neither
publishes a public one. Stick with `cl100k_base` as a reasonable
proxy; document the residual ±10% in the file header.

---

## ~~3. Recap-of-recaps cleanup on re-compress~~ ✅ shipped

Folding implemented in `buildCompressedMessages` (pure, in
`lib/shared/compression.ts`) + the summariser-input prepend in
`CompressButton`. Re-compressing now drops the prior recap row and
inherits its `recapMessageIds`, so one Undo restores every span and
only one recap card ever shows. Original notes below.

**Why.** `compressMessages` excludes existing `kind: 'recap'`
messages from the eligible pool, so a second Compress doesn't
summarise a prior summary — but the old recap stays in place. Over
time a long conversation can accumulate three or four stale recaps,
each summarising a different historical span. They render fine but
they're noise.

**Approach.**

- When `compressMessages` runs, look at the prior recap (if any)
  immediately before the new compression slice.
- If it exists, fold its content into the new recap's input prompt
  (prepended to the messages list with the marker "Previous summary:
  …"). The summariser produces one merged recap covering both spans.
- Delete the old recap row and concatenate its `recapMessageIds`
  into the new recap's array (so Undo restores both spans at once).

**Verification.**

- Compress, then compress again. Verify only one recap row exists.
- Undo on the merged recap restores **all** previously compressed
  messages.
- Sync: the old recap row gets a delete op; the new one gets an
  upsert. Two-device test — verify both devices converge.

**Out of scope.** Time-bounded recaps ("only the last hour"). Recap
content quality tuning beyond the prompt change.

---

## ~~4. Lazy signed-URL re-sign for generated images~~ ✅ shipped

`signGeneratedImageUrl(storagePath, client?)` helper +
`POST /api/images/refresh-url` route (auth + first-path-segment-vs-
`auth.uid()` check), `RefreshImageUrlRequestSchema` + response shape
in `api-schemas.ts`, `apiClient.images.refreshUrl(storagePath)` with
in-flight dedupe by storagePath, gallery `<img onError>` → refresh →
new `updateMessageGeneratedImageUrl` mutator on the messages slice.
One refresh attempt per tile mount; subsequent failures fall through
to the browser's broken-image placeholder. Data-URL fallbacks skip
the refresh path. Tests for the request schema cover the
path-traversal + empty/missing-field rejections.

**Why.** Signed URLs minted by `persistGeneratedImages` have a
1-year TTL (`SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365`). Anyone
with a year-old conversation hits an expired URL. The bytes are
still in Storage at `storagePath`; we just need to re-sign.

**Approach.**

- Add a small server-only helper
  `lib/server/image-storage.ts:signGeneratedImageUrl(storagePath: string)`
  that returns a fresh 1-year URL.
- Add a route `POST /api/images/refresh-url` that takes
  `{ storagePath }`, authorises against the caller's `auth.uid()`
  (RLS handles this — `(storage.foldername(name))[1] = auth.uid()::text`
  policy already in `0003_storage.sql`), and returns the new signed
  URL.
- On the client, when a `<img>` in `GeneratedImagesGallery` emits an
  `onError` event AND the underlying `GeneratedImage` has a
  `storagePath`, fire one refresh attempt. On success, update the
  store with the new URL and re-render. On failure, render the
  existing broken-image placeholder.
- Debounce + cache: store the refresh in flight by `storagePath`
  so a 4-up grid hitting the same expired URL only refreshes once.

**Verification.**

- Manually rewrite a stored URL to a known-invalid token. Open the
  conversation; the broken-image flash → refresh → fresh image
  loads.
- Anonymous mode: data: URLs don't have a `storagePath`, so no
  refresh is attempted — broken image stays broken (correct).
- RLS: a second user's `storagePath` (if they knew it) doesn't
  validate; the route returns 403. No cross-user leakage.

**Out of scope.** Proactive refresh of all URLs in a conversation on
load (wasteful). One-shot URL revocation (Supabase doesn't really
support that; rotating the underlying bytes would be the path).

---

## ~~5. ROADMAP refresh sweep (housekeeping)~~ ✅ done (this PR)

Swept PRs #43, #45, #49–53 into the ROADMAP Shipped table and
fixed the small-followups status line. Recurring chore — re-run
whenever the table drifts. Original notes kept below.

**Why.** `docs/MASTER_PLAN.md` got stale within hours of landing — a
few features shipped immediately after. A periodic sweep keeps it
useful as a single source of truth.

**Approach.** Pure docs change. Walk `git log --since='<last roadmap
date>'` against `dev`, find PRs that need a row in **Shipped**,
and move any **Planned** entries that shipped. Bump `Last updated:`.

Concrete items currently stale (as of this plan's authoring):

- File full-text retrieval **Phase 3** has shipped (PR #40,
  `lib/server/skills/file-search.ts`). Update the **Planned** row to
  remove "Phase 3 pending"; move the achievement into **Shipped**.
- DOCX / CSV / text file previews shipped (commit `647b23d`) — add a
  **Shipped** row.
- Image-viewer drawer + Maximize2 action (commit `2c1e1ea`) — add a
  **Shipped** row.

**Verification.** Skim the file after editing. Confirm every link
resolves. Confirm no "in progress" rows refer to merged branches.

**Out of scope.** Restructuring sections. Just a content sweep.

---

## ~~6. Local-mode MCP creds on task launch / respond~~ ❌ moot

Superseded by [#85](https://github.com/juchengquan/hummingbird/pull/85)
(Phase 6 steps 3+4 of the task-queue plan). Tasks now run
**asynchronously in a background worker** that has no path to the
browser-held credentials, so the start and respond routes
**deliberately reject** `body.mcpServers` up front with a clear error
("Local-mode MCP servers aren't supported in async task mode. Connect
the server as a cloud-mode workspace MCP, or use the chat route for
this workflow.").

A future path to lift this limitation is documented in
`PLAN-agent-task-queue.md` under *Trade-offs / open questions* —
e.g. pushing local creds to Supabase (encrypted) on enqueue with a
TTL evict. Not on the current roadmap; cloud-mode MCP covers the
common case.

---

## 7. Per-tool server-side approval flags

**Why.** Today the gated-tool list for a task is `body.requireApprovalFor`
(an explicit list of prefixed names from the client). For a workspace
that has e.g. a "Filesystem-Writer" MCP server, we want server-side
policy: any tool on that server requires approval, no client opt-in
needed.

**Approach.** Add a `requires_approval boolean default false` column to
`mcp_servers` (and/or a per-tool override on the descriptor). In the
task route, when building tools, union `body.requireApprovalFor` with
the server's flag — gate accordingly. Surface a toggle in the MCP
server config dialog.

**Verification.** Toggle a server's flag → next task pauses on any of
its tool calls regardless of `body.requireApprovalFor`. Toggle off →
runs through.

**Out of scope.** Per-tool granularity within a server. Defaults
(e.g. "always-gate destructive verbs"). The MCP spec evolution.

---

## 8. Route-handler integration tests for the task stack

**Why.** Pure logic in the agent stack is unit-tested (`reduceRun`,
`RunEmitter`, `makeStreamTextStep` control flow with a fake step,
the SSE decoder, the active-task codec). The HTTP handlers
themselves (`app/api/tasks/route.ts`, `[id]/respond/route.ts`,
`[id]/stream/route.ts`, `sweep/route.ts`) aren't — auth, body
validation, sink wiring, persistence chain, suspend → checkpoint,
respond → continuation are all integration-level today.

**Approach.** A small Supabase + AI-SDK harness — likely an in-memory
`SupabaseClient` stub matching the chained-query API the store uses,
plus a fake `streamText` driver (we already have `RunStepFn` as the
seam for the loop). Then a handful of end-to-end tests: start →
settle, start → cancel, suspend → respond approve, suspend → respond
reject, resume mid-run, sweep flips stale runs to `failed`.

**Verification.** `bun test` covers the handler paths without hitting
Supabase or a real model. New tests live next to the routes
(`*.handler.test.ts`).

**Out of scope.** Full e2e with a real model / Supabase — that's the
browser walkthrough in `docs/VERIFY-agent-tasks.md`.

---

## How to ship one

1. Pick an item.
2. Branch off `dev` (`claude/followup-<short-name>`).
3. Implement + add `bun test` coverage where the item has logic
   (items 1, 2, 3 do; items 4, 5 don't need it).
4. `bun run check`.
5. Open a single-purpose PR. Tag the section number in the PR
   description so this file can be updated alongside.
6. After merge, delete the section from this file (or strike-through
   with `~~heading~~` + a one-line "✅ shipped (PR #N)" — same
   pattern as the **Later — distinctive ideas** section in
   `MASTER_PLAN.md`).
