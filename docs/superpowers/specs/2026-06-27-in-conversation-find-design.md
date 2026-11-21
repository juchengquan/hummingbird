# In-conversation Find (⌘F) — design

**Date:** 2026-06-27
**Status:** Approved (brainstorming) — pending implementation plan

## Problem

There's no way to find text *within* the open conversation. The sidebar
search filters the conversation *list* (by title + body), but inside a
long thread you can't jump to a remembered phrase. Browser-native ⌘F is
the only option today and it's clumsy (matches chrome, no scoping).

## Goal

A ⌘F find bar scoped to the open conversation: type a query, every
occurrence highlights in place, `Enter`/`Shift+Enter` jumps next/prev with
a `current / total` count, `Esc` closes. Client-only; no backend.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Match surfacing | **Per-occurrence highlight via the CSS Custom Highlight API** (no DOM mutation), with a **message-level fallback** when the API is absent |
| Search scope | **Rendered visible text** of the open conversation (so highlights align exactly; collapsed reasoning isn't matched — a noted v1 limitation) |
| Case | **Case-insensitive only** (no toggle in v1) |

### Why the CSS Custom Highlight API

Assistant messages render markdown → HTML via `dangerouslySetInnerHTML`
(`components/markdown-preview.tsx`) with interleaved citation `<button>`s.
Wrapping matched substrings in `<mark>` would risk splitting that markup.
`CSS.highlights` overlays styled ranges on existing text nodes **without
mutating the DOM**, so citations + markdown stay intact. Supported in
current Chromium/Safari/Firefox; the fallback covers the rest.

## Components

### 1. Pure helpers — `lib/shared/find/match.ts` (isomorphic, unit-tested)

```ts
/** Case-insensitive occurrence start-offsets of `needle` in `haystack`.
 *  Non-overlapping, left-to-right. Empty/whitespace-only needle → []. */
export function findMatchOffsets(haystack: string, needle: string): number[]

/** Next/prev index with wrap-around. dir: 1 = next, -1 = prev. Returns 0
 *  for total <= 0. */
export function wrapIndex(current: number, total: number, dir: 1 | -1): number
```

These hold the only logic worth unit-testing; everything else is DOM / React.

### 2. `useConversationFind` hook — `lib/client/hooks/use-conversation-find.ts`

Owns find state + the highlight engine. Returns
`{ open, query, setQuery, total, current, next, prev, openFind, close }`.

- **Highlight engine.** When `open` and `query` is non-empty, walk the
  text nodes under the messages container (the
  `[data-slot="scroll-area-viewport"]` viewport, or the messages list
  `<div>`), accumulating a flat string + a `(node, offset)` map. For each
  occurrence (via `findMatchOffsets` over the flat text), build a DOM
  `Range`. Register them:
  `CSS.highlights.set("find-all", new Highlight(...ranges))` and
  `CSS.highlights.set("find-current", new Highlight(ranges[current]))`.
- **Re-walk triggers:** query change (debounced ~120ms), `open` toggling
  true, and the active conversation's `messages` changing while open
  (streaming appends become findable). Each re-walk rebuilds ranges and
  clamps `current`.
- **Navigation:** `next`/`prev` move `current` via `wrapIndex`, re-set
  `find-current`, and scroll the active range's start node into view
  (reuse the viewport `scrollTo` pattern from `use-chat-scroll.ts`).
- **Cleanup:** on `close`/unmount, `CSS.highlights.delete("find-all")` +
  `delete("find-current")`.
- **Fallback (no `CSS.highlights`):** compute matching message ids from
  the `messages[].content` strings; `next`/`prev` scroll to
  `#chat-message-{id}` and apply a brief ring class; `total` = matching
  message count. (No per-word overlay.)

### 3. `ConversationFindBar` — `components/panels/conversation-find-bar.tsx`

A small floating bar pinned top-right of the messages column (absolute,
above the scroll area). Contents: a text `<input>` (autofocus), a
`current / total` (or "No results") readout, prev/next chevron buttons,
and a close ✕. Keyboard: `Enter` = next, `Shift+Enter` = prev, `Esc` =
close. Rendered only when `open`.

### 4. ⌘F wiring (in `components/panels/chat.tsx`)

A `keydown` listener mirroring the ⌘K pattern in `command-palette.tsx`:
when `(metaKey || ctrlKey) && key === "f"` **and** the chat view is active
with a conversation open → `preventDefault()` (block native find) →
`openFind()`, pre-filling `query` from the current text selection if any
(reuse `captureSelectionSnapshot`). Mount `<ConversationFindBar>` + the
hook in the chat panel.

### 5. Global CSS (`app/globals.css` or the existing chat CSS)

```css
::highlight(find-all)      { background: color-mix(in srgb, gold 55%, transparent); }
::highlight(find-current)  { background: color-mix(in srgb, orange 70%, transparent); }
```

(Plus a brief `ring` utility class for the fallback's message flash.)

## Data flow

```
⌘F (chat active + conversation open)
  └─ preventDefault → openFind(prefill = selection)
        └─ query change (debounced)
              └─ walk viewport text nodes → flat text + node map
                    └─ findMatchOffsets(text, query) → ranges
                          └─ CSS.highlights.set("find-all", …) + "find-current"=ranges[0]
Enter / ↓ / next-button
  └─ current = wrapIndex(current, total, +1)
        └─ set "find-current" = ranges[current] → scroll its node into view
Esc / ✕
  └─ close → CSS.highlights.delete("find-all"/"find-current")
```

## Error handling / edges

- Empty/whitespace query → no highlights; count hidden; nav disabled.
- Zero matches → "No results"; nav disabled.
- Re-walk clears the prior `Highlight` before rebuilding (no leak); `current`
  clamped to `[0, total)`.
- Streaming while open → re-walk so new text is findable.
- Collapsed reasoning blocks aren't in the DOM → not matched (matches
  "what's visible") — documented v1 limitation.
- `CSS.highlights` undefined → message-level fallback (above); the bar +
  nav still work.
- ⌘F only intercepts when the chat view is active + a conversation is
  open; otherwise the browser's native find is left alone.

## Testing

- **`findMatchOffsets`** — multiple occurrences, case-insensitivity, no
  match, empty/whitespace needle → [], overlapping-avoidance, needle at
  string edges.
- **`wrapIndex`** — next wraps `total-1 → 0`; prev wraps `0 → total-1`;
  `total = 0 → 0`; mid-list step.
- The hook (DOM walk + Highlight API), the bar, and the ⌘F wiring are
  **not** render-tested (no `@testing-library` in the repo) — verified by
  review + a manual runbook (`docs/SMOKE-TEST-in-conversation-find.md`).

## Manual verification

Open a long chat. ⌘F → the bar appears (browser find does NOT). Type a
word present several times → all occurrences highlight, the first is
emphasized, count shows `1 / N`. `Enter` cycles forward (scrolling each
into view) and wraps; `Shift+Enter` backward. Select text first, then ⌘F →
the query is pre-filled. `Esc` closes and clears highlights. Type while the
assistant streams → new text becomes findable. (If on a browser without
`CSS.highlights`, confirm the message-level fallback jumps + rings.)

## Out of scope (v1)

- Regex, whole-word, case-sensitive toggle.
- Cross-conversation search (the sidebar already does title + body).
- Find-and-replace.
- Matching inside collapsed reasoning / off-screen-unrendered content.
