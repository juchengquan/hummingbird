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

## 1. Cross-device sync of `Message.generatedImages` metadata

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

## 3. Recap-of-recaps cleanup on re-compress

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

## 4. Lazy signed-URL re-sign for generated images

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

## 5. ROADMAP refresh sweep (housekeeping)

**Why.** `docs/ROADMAP.md` got stale within hours of landing — a
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
   pattern as `BACKLOG.md`).
