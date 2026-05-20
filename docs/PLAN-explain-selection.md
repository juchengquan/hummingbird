# Plan: Explain selection — selection-driven AI actions

Status: **planning** — no code yet.

A small set of selection-driven actions (`Explain`, `Quote in reply`)
surfaced through a floating toolbar on desktop and a chip + bottom
sheet on mobile. The selected text becomes the unit of context for an
on-the-fly model call; the result either lives ephemerally in a
popover/sheet or gets pinned for later reading.

Builds on infrastructure already in the codebase: the chat route
(`app/api/chat/route.ts`) for streaming, the citations strip
(`components/panels/sources-strip.tsx`) for sources when web search
runs, and the existing AI Gateway integration.

## Why

When the user is reading an assistant answer and wants more detail
about a specific phrase, today the only path is to type "what does X
mean?" into a new turn — losing the spatial context and adding a turn
that clutters the conversation. Selection-driven actions collapse
that to one click and produce an answer that's actually scoped to
*this passage* without dragging along the rest of the chat.

The conversation history is still part of the context (so "explain
this" understands what we've been talking about), but the selection
itself is the focal point, and the result doesn't have to become a
permanent turn unless the user pins it.

## Goal & scope cuts

**v1 ships:**

- Two actions only: `Explain` and `Quote in reply`. Both work on any
  text selection inside an assistant message in the chat panel.
- Desktop: selection-anchored floating toolbar + anchored popover for
  the streamed result + pin-to-side-panel affordance.
- Mobile: floating chip above the selection + bottom sheet for the
  result.
- Keyboard parity: `⌘E` to run Explain, `Esc` to dismiss popover,
  `⌘↵` to pin. `⌘K` command palette gets `Explain selection` /
  `Quote selection in reply` entries.
- Reuses the existing chat streaming infrastructure — no new route.
- Result rendering reuses `MarkdownPreview` + `SourcesStrip`, so
  citations work for free when web search is on.

**Cut from v1 to keep it shippable:**

- **More than 2 actions.** No `Find sources`, `Translate`, `Rewrite`.
  Earn these by user demand, not speculative menu padding.
- **Editor reuse.** Plate.js already has a selection-driven AI menu
  (`components/ui/ai-menu.tsx`). Sharing primitives between the two
  is Phase 2 — touching Plate's surface in the same change is risky.
- **Drag-to-quote.** Desktop-only affordance from the discussion;
  defer until selection toolbar proves the surface is right.
- **PWA share-target integration on mobile.** Out of scope.
- **Multi-message selection.** Selection must stay within a single
  message bubble. Cross-message selection (rare, awkward to scope)
  is rejected with a small "select within one message" toast.
- **Persistence beyond pin.** Pinned cards live in session memory.
  Saving them to a workspace-scoped "Notes" or "Snippets" store is
  Phase 2.

## Surface architecture

### Three new components

**`components/selection/selection-trigger.tsx`** — listens to
`selectionchange` globally, debounced 150 ms. Owns the
`SelectionState` { range, rect, scopeMessageId, text }. Decides
whether to render the desktop toolbar or mobile chip based on
`useIsTouchDevice()` (already in `lib/client/hooks/`). Tears down on
click-away.

**`components/selection/selection-toolbar.tsx`** — desktop. Horizontal
floating toolbar above the selection: `Explain` + `Quote in reply` +
small `⌘E` kbd hint. Positioned above by default, flips below when
near the top of viewport. Coexists with the native right-click menu;
disappears on new selection or scroll-away.

**`components/selection/selection-chip.tsx`** — mobile. Single
`Sparkles Explain` chip floating above the selection. 32 px visual,
44×44 px touch target per Apple HIG. Positioned to clear the OS
selection handles. Disappears on selection collapse.

### Two result surfaces

**`components/selection/explain-popover.tsx`** — desktop. ~440 px wide,
anchored to the right of the selection (or left when no room).
Streamed answer renders via `MarkdownPreview`. Header carries a
truncated "Re: '<selected text>'" label, the model name, and a `Pin`
button (`⌘↵`). Dismisses on click-away (default) or Esc.

**`components/selection/explain-sheet.tsx`** — mobile. Bottom sheet
that slides up ~60% viewport, swipe-down to dismiss. Same content as
the popover. Pin button promotes to a Saved tab in the right activity
bar.

### One supporting feature

**Quote in reply** doesn't open a popover — it inserts the selected
text as a styled blockquote into the chat input, places the cursor
below, and focuses. The user types their follow-up + sends as a
normal message. Implementation is just a setter on the input's text
state with a chunk like `> Selected text here\n\n`.

## Data flow

```
User selects text inside an assistant message
   │
   ▼
selectionchange (150 ms debounce)
   │
   ▼
SelectionTrigger detects scope (msg id, range, rect, text)
   │
   ▼
Renders SelectionToolbar (desktop) or SelectionChip (mobile)
   │
   ▼
User taps Explain (or ⌘E / ⌘K → Explain selection)
   │
   ▼
ExplainPopover (desktop) / ExplainSheet (mobile) opens
   │
   ▼
POST /api/chat with:
  - messages = [...currentConversationHistory, syntheticUserTurn]
  - syntheticUserTurn = { role: 'user', content: explainPrompt(selection) }
  - skills: { webSearch: currentConvWebSearchEnabled }  ← cascade-aware
   │
   ▼
SSE stream → MarkdownPreview + SourcesStrip (if web search ran)
   │
   ▼
User dismisses (click-away / Esc / swipe-down) → ephemeral, gone
                          OR
User pins (⌘↵ / Pin button) → docked in side panel until conversation closed
```

### The synthetic user turn

```ts
function explainPrompt(selection: string): string {
  return [
    'Explain the following passage from the assistant message above,',
    'in plain language and in the context of this conversation.',
    'Keep it concise — 2-3 paragraphs at most.',
    'If you cite sources, use the [N] marker format.',
    '',
    `Passage: """${selection}"""`,
  ].join('\n')
}
```

The synthetic turn is NOT persisted to `messages`. It's a transient
request whose result lives in the popover/sheet until pinned.

## Files

**New:**

- `components/selection/selection-trigger.tsx` (~80 lines)
- `components/selection/selection-toolbar.tsx` (~100 lines)
- `components/selection/selection-chip.tsx` (~70 lines)
- `components/selection/explain-popover.tsx` (~140 lines)
- `components/selection/explain-sheet.tsx` (~100 lines)
- `lib/client/hooks/use-selection.ts` (~80 lines) — wraps
  `selectionchange` + debounce + rect computation + scope detection
- `lib/shared/selection-prompts.ts` (~30 lines) — isolated prompt
  templates so they're testable + tunable without touching React

**Modified:**

- `components/panels/chat-message.tsx` — wrap content in a marker
  attribute (`data-selection-scope="message-{id}"`) the trigger can
  detect; no other changes
- `components/panels/chat.tsx` — mount `SelectionTrigger` once near
  the message list. Handle the `Quote in reply` callback by setting
  input text via existing input state setter
- `components/command-palette.tsx` — add two entries:
  `Explain selection` (disabled when no selection), `Quote selection
  in reply` (disabled when no selection)
- `app/dashboard/page.tsx` — mount the pinned-explanations side panel
  (a new `<ExplainPinnedHost />` near `<PdfViewerHost />`)

**Untouched but worth knowing:**

- `app/api/chat/route.ts` — unchanged. Selection actions reuse the
  existing route by injecting the synthetic user turn at the client.
- `lib/client/hooks/use-store.ts` — no new persisted state. Pinned
  explanations live in session-only state (Zustand slice not
  persisted), so they don't survive reload by design.

## Phases

### Phase 1 — Desktop, chat-only

1. `useSelection` hook + `SelectionTrigger` + `SelectionToolbar`
2. `ExplainPopover` calling `/api/chat` via the existing
   `apiClient.chat.stream`
3. `Quote in reply` wiring
4. `⌘E` shortcut

Ship as one commit. Branchpoint: confirm popover feels right before
adding pin.

**Deferred from Phase 1: `⌘K` palette entries.** When the user opens
the palette, focus moves to the palette input, which collapses the
document selection. The entries would need to snapshot the selection
on palette-open via a non-persisted Zustand slice that the trigger
writes to on `selectionchange`. Not a huge lift, but worth its own
small commit alongside Phase 2 (pin to side panel), which will need
the same cross-component selection state anyway.

### Phase 2 — Pin to side panel

Adds the dock target + a session-only `pinnedExplanations` slice. One
commit; doesn't touch Phase 1 internals.

### Phase 3 — Mobile

`SelectionChip` + `ExplainSheet` + touch-device branching in
`SelectionTrigger`. Carefully tested on iOS Safari + Android Chrome.
Visual viewport math for the chip + sheet positioning.

### Phase 4 — Editor reuse

Refactor `SelectionToolbar` into a primitive that Plate's AI menu
also uses. Out of scope right now; document as a follow-up.

## Verification

Manual walk-through after each phase, with these as the must-pass
checks:

**Phase 1 (desktop):**

1. Select text inside an assistant message → toolbar appears above
   selection within ~150 ms.
2. Click `Explain` → popover opens to the right of the selection;
   answer streams in via MarkdownPreview.
3. Web search enabled + explain runs `webSearch` → SourcesStrip
   renders inside the popover with clickable `[N]` markers.
4. Click outside the popover → it closes; selection is preserved.
5. Press `⌘E` with a selection → same flow as clicking `Explain`.
6. Open `⌘K` → `Explain selection` entry visible (only when
   selection is active).
7. Click `Quote in reply` → input gets a `> ...` blockquote prefix,
   cursor lands below, focus moves to input.
8. Select text in a user message (not assistant) → toolbar does NOT
   appear. Selection actions are assistant-only.
9. Right-click on selection → native browser context menu opens
   normally. Our toolbar coexists.

**Phase 2 (pin):**

10. Click `Pin` in popover → popover collapses into the side panel;
    selection toolbar's `Explain` still triggers a fresh popover.
11. Pinned cards survive scroll, route to chat sidebar, view changes
    within the dashboard.
12. Reload the page → pinned cards are gone (session-only, by design).

**Phase 3 (mobile):**

13. iOS Safari: long-press to select → native handles + chip both
    appear; chip doesn't overlap handles.
14. Android Chrome: same.
15. Tap chip → sheet slides up; swipe-down dismisses.
16. Sheet result includes SourcesStrip on web-search-triggered
    explanations.
17. Keyboard up during selection (Android) → chip + sheet don't
    end up under the keyboard.

## Risks

- **OS selection menus on mobile.** iOS sometimes consumes touch
  events before our chip can position. Mitigation: position from
  `selectionchange` after a 150 ms debounce; if iOS gestures cancel
  our handler, the chip simply doesn't appear and the user can still
  use copy/share normally.
- **Right-click users discover by accident the toolbar coexists with
  the context menu — could be visually busy.** Mitigation: toolbar
  fades out at low opacity while the native menu is detectably open
  (track via `contextmenu` event without preventing default).
- **Plate.js editor will eventually want the same primitives.** Risk:
  building chat's toolbar without the editor in mind locks us into
  divergent visual languages. Mitigation: Phase 4 explicitly factors
  the toolbar primitive into a shared module after both surfaces
  stabilise.
- **Cost.** Every Explain is a model call. Mitigation: use the
  conversation's current model. Power users already chose Haiku /
  GPT-4o-mini / DeepSeek Flash for cost; we don't override that.
  Optional v2: per-action model override (e.g. always use Haiku for
  explanations regardless of chat model).

## What we're explicitly NOT doing

- Replacing the browser's right-click menu. The toolbar *coexists*.
- Persisting selection-explain results to `messages`. They live in
  the popover or session-only pinned slice.
- A general "AI menu" for arbitrary editor-style operations (Rewrite,
  Translate, Continue) on chat selections. Two actions ship; more
  earn their place by user request.
- Cross-message selection. Selection scoped to a single bubble.

## Open questions to resolve before Phase 1

1. **Should `Explain` be available on user messages too**, or
   assistant-only? Defaulting to assistant-only in this plan. Reason:
   selecting your own message and asking "explain this" is weird —
   you wrote it. Re-evaluate if users ask.
2. **Pinned cards: visible from any conversation, or only the one
   they were pinned in?** Currently planned: scoped to the
   conversation that produced them, cleared on conversation switch.
3. **Quote in reply: include the source message's id as a link?**
   Like Slack thread quotes. Probably yes for context, but adds UI;
   defer to first user request.

These are small and can be resolved during Phase 1 implementation —
just calling them out so they don't become bikeshed material later.
