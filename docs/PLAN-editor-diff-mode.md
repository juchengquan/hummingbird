# Plan: Diff mode for editor AI commands

Status: **planning — may be picked up in a parallel session.** No
code in `dev` yet. Rewritten after surveying the existing Plate
suggestion infrastructure; original plan overestimated the scope by
~2× because much of the Track Changes UX is already wired. If you're
about to start work on this, check open PRs and branches matching
`claude/editor-diff-*` or `*editor-diff-mode*` first to avoid
duplication.

When the rich-text editor's AI command (`/api/ai/command`) modifies
the document, the user reviews each change before it commits —
accepting or rejecting individual chunks. The end-state UX matches
Word / Google Docs Track Changes: additions in green underline,
deletions in red strikethrough, per-chunk action chip on hover or
keyboard focus.

Builds on substantial existing infrastructure in `@platejs/ai/react`
+ `@platejs/suggestion`. The work in this PR is *closing the gaps*
around what's already there, not reimplementing the Track Changes
foundation.

## Why

Today the editor AI is "ask, get a result, hope it's right." If it
overwrites a paragraph the user wrote carefully, they have to discard
the whole thing and re-prompt — there's no granular escape hatch. A
proper diff review lets the user keep the parts that landed well,
reject the parts that didn't, and re-prompt the rejected sections
without losing the wins.

This is also where AI writing tools start to feel like a collaboration
rather than a slot machine: the user is reviewing the model's edits,
not gambling on whether to overwrite their draft.

## What's already there (post-survey)

The plan was written before tracing the actual code. Here's what
Plate + the existing app already do for AI edit operations:

| Capability | Where |
|---|---|
| AI's `edit`-mode output applied as Slate **suggestion marks** (insert / remove) | `components/editor/plugins/ai-kit.tsx:80` calls `applyAISuggestions(editor, content)` |
| **Green underline / red strikethrough** rendering of those marks with hover-active highlight | `components/ui/suggestion-node.tsx` (the leaf renderer) |
| **Per-block accept/reject popover** (`✓` / `✕` buttons revealed on hover) calling `acceptSuggestion()` / `rejectSuggestion()` | `components/ui/block-suggestion.tsx:221-238`, mounted by `BlockDiscussion` in `discussion-kit.tsx:141` via Plate's `aboveNodes` slot |
| **Accept-all** action in the AI menu | `components/ui/ai-menu.tsx:281-292` calls `editor.getTransforms(AIChatPlugin).aiChat.accept()` |
| **Discard** (reverts all of this AI session) | `aiChatItems.discard` in `ai-menu.tsx:330` |
| `useResolveSuggestion` for enumerating pending suggestions per block | `block-suggestion.tsx:249` |

That's most of the UX the original plan proposed to build.

## Real gaps to fill

After the survey, four concrete things are missing:

1. **"Review changes" toggle on the AI menu.** Today the suggestion
   flow is unconditional for `edit` operations — there's no
   power-user opt-out for "just blast-replace the text, I trust the
   model." Toggle gates `applyAISuggestions` vs a direct mutation
   path in `ai-kit.tsx`.

2. **Review bar with "N AI changes pending" + explicit
   "Reject remaining."** Today, after the user accepts some
   suggestions individually, the global `discard` action would
   revert *everything* (including the chunks they already
   committed). The actual semantics most users expect is "reject the
   ones I haven't acted on yet, keep what I've already accepted."
   This needs a new transform that walks the editor for unresolved
   suggestions and calls `rejectSuggestion` on each.

3. **Keyboard navigation between changes.** Today the per-chunk
   affordance is hover-only — accessibility and power-user
   discoverability are both weak. `Tab` / `Shift+Tab` cycles
   through pending suggestions; `Y` accepts the focused one, `N`
   rejects it; `⌘↵` accepts all + dismisses; `Esc` rejects
   remaining + dismisses.

4. **Per-prompt diff state visibility.** Today the user has to
   discover the per-block hover affordance accidentally — there's
   no UI cue that says "this paragraph has pending AI changes,
   hover here to review." A small floating "✦ N pending" pill
   anchored to the first pending suggestion makes the affordance
   visible without changing the underlying decoration.

The original plan also proposed inline word-level highlights via
`fast-diff`. Skip this — Plate's suggestion-mark coloring is
already paragraph-level inline, and the model emits replacements
at sentence/clause granularity, not word-level. Adding a second
diff layer would conflict visually with the existing marks.

## Goal & scope cuts

**v1 ships:**

- The four gaps above.
- **"Review changes" toggle is on by default** for `edit`-mode AI
  commands. Power users can flip it off per-prompt. The toggle
  persists per user (in `useStore.editorPrefs`).
- **`Tab` / `Shift+Tab` / `Y` / `N` / `⌘↵` / `Esc`** keyboard
  shortcuts active whenever any pending AI suggestion exists in the
  editor.
- **The floating review pill** sits in the bottom-center of the
  editor while pending suggestions exist; clicking it scrolls to
  the first pending suggestion and gives it focus. Pill also carries
  `Accept all` / `Reject remaining` controls — the same surface the
  AI menu has, just always visible during review.

**Cut from v1:**

- **`generate` and `comment` flows.** They don't produce
  pre/post comparable text — different UX shape. The toggle and
  review bar only show for `edit` mode.
- **Word-level inline highlights via `fast-diff`** (was in the
  original plan). Plate's suggestion marks already paint
  paragraph-internal inserts/removes; another diff layer adds
  visual noise without a clear win.
- **Per-chunk regenerate (↻).** Cute but needs server-side
  per-chunk prompt support. Defer.
- **Custom decoration plugin** (was the original plan's centerpiece).
  Plate's existing suggestion leaf does the rendering; we don't
  need our own.
- **Snapshot-and-observe interception of `useChatChunk`.** Not
  needed — `applyAISuggestions` already keeps the original text
  alongside the proposed text as suggestion marks. No separate
  snapshot to maintain.

## Surface architecture

### Single integration point

`components/editor/plugins/ai-kit.tsx` is the seam. The `onChunk`
callback for `toolName === 'edit' && mode === 'chat'` either calls
`applyAISuggestions(editor, content)` (today's behaviour, the new
default) or applies the content directly via Plate's text
insertion APIs (the new opt-out path).

The toggle is read from a new editor pref:

```ts
// lib/client/hooks/use-store.ts — extend editorPrefs
interface EditorPrefs {
  aiReviewChanges: boolean // default true
}
```

`useChat` (already mounted in `ai-kit.tsx`) reads the toggle and
passes it through the request body so the server can include it in
diagnostics. The actual gate is client-side in `ai-kit.tsx`.

### Three new components

**`components/editor/ai-review-pill.tsx`** — floating bottom-center
pill, mounted via Plate's `afterEditable` slot (same pattern as
`AIMenu`). Renders only when there's at least one unresolved AI
suggestion in the editor. Shows:

- `✦ N AI changes pending`
- `Accept all` / `Reject remaining` buttons
- `↑ ↓` jump-to-next/prev shortcuts displayed as kbd hints

Closes itself automatically when the count drops to zero (last
suggestion accepted or rejected).

**`components/editor/ai-review-keymap.tsx`** — `useEffect` hook
mounted near the editor that registers `Tab` / `Shift+Tab` / `Y` /
`N` / `⌘↵` / `Esc` while pending suggestions exist. Uses Plate's
existing hotkey API (`useHotkeys` from `platejs/react`). On `Y`/`N`
it acts on the currently-focused suggestion (the one whose
`activeId` matches `usePluginOption(suggestionPlugin, 'activeId')`).

**`components/ui/ai-menu-review-toggle.tsx`** — a small toggle UI
in the AI menu's command bar showing "Review changes" with the
current default state. Persisted per-user.

### One new transform helper

**`lib/client/editor/reject-remaining-ai-suggestions.ts`** — walks
the editor for suggestions whose `userId` matches the AI session
and whose status is unresolved, and calls `rejectSuggestion(editor,
suggestion)` on each. Used by `Esc` and the pill's
"Reject remaining" button.

Pure helper, easy unit test against a mock editor.

## Edge cases

- **AI command aborted mid-stream.** Already handled by the existing
  `aiChat.discard` path. No behaviour change for this case.
- **User edits the doc while suggestions are pending.** The
  suggestion plugin already tolerates this — manual edits sit
  alongside pending suggestions without conflict. Our keymap
  defers to standard editor input when the focus is in an
  unsuggested range.
- **Multiple AI edit sessions overlap (rare).** Each session's
  suggestions carry a distinct `userId` (the AI plugin's session
  id), so `rejectRemainingAiSuggestions` scopes by session and
  doesn't blast across sessions.
- **No suggestions to navigate.** `Tab` falls through to the
  editor's normal handling (cycling focusable elements / inserting
  a tab character based on Plate's defaults).
- **Review-changes toggle flipped mid-stream.** Take the value at
  send time; don't apply mid-stream toggle changes.

## Files touched

| File | Why |
|---|---|
| `components/editor/plugins/ai-kit.tsx` | Read `aiReviewChanges` pref; gate `applyAISuggestions` vs direct mutation path |
| `components/editor/ai-review-pill.tsx` *(new)* | Bottom-center pending-changes pill |
| `components/editor/ai-review-keymap.tsx` *(new)* | Tab/Y/N/⌘↵/Esc shortcuts |
| `components/ui/ai-menu-review-toggle.tsx` *(new)* | "Review changes" toggle in the AI menu |
| `components/ui/ai-menu.tsx` | Wire the toggle into the AI menu surface |
| `lib/client/editor/reject-remaining-ai-suggestions.ts` *(new)* | Pure helper walking unresolved suggestions |
| `lib/client/editor/reject-remaining-ai-suggestions.test.ts` *(new)* | Unit tests on the walker |
| `lib/client/hooks/use-store.ts` | Add `editorPrefs.aiReviewChanges` (default true), persist |

**~150 lines** of new code + ~50 of tests. Down from the original
plan's ~350 because the decoration / per-block accept/reject infra
is already in Plate.

## Test plan

- **`reject-remaining-ai-suggestions.test.ts`** *(new, ~8 cases):*
  - Empty editor → no-op
  - No pending suggestions → no-op
  - All unresolved → all rejected
  - Mixed accepted/unresolved → only unresolved rejected
  - Scoped by `userId` — doesn't reject another session's pendings
  - Idempotent — calling twice doesn't double-reject
- **`useStore` slice test** *(extend existing):*
  - Default `editorPrefs.aiReviewChanges === true`
  - Toggle persists across rehydrate
- **Manual UX** (deferred to dev):
  - Run AI edit on a paragraph → suggestions appear → pill shows
    "1 AI change pending" → `Y` accepts, pill disappears
  - Multi-paragraph edit → `Tab` cycles between pending chunks →
    each gets its own accept/reject verdict
  - Toggle "Review changes" off → run AI edit → text replaces
    directly with no suggestion marks (today's blast-replace)
  - `Esc` during review → all unresolved suggestions rejected, the
    accepted ones survive (verifies the "reject remaining" vs
    "discard all" distinction)
- Existing 338+ tests stay green.

## Effort

~3–4 days end-to-end including manual UX verification. The bulk is
the keyboard navigation getting the focus-and-jump-to-next behaviour
right; the toggle and pill are straightforward.

## Risk

**Low.** Plate's suggestion + AI plugins do the heavy lifting; the
new code is glue. Two specific risks:

1. **`acceptSuggestion` / `rejectSuggestion` ergonomics may not
   expose the per-session scoping the "reject remaining" walker
   needs.** Mitigation: if the API doesn't scope by session id,
   walk the document for all unresolved AI suggestions instead —
   slightly more permissive but fine for v1 since concurrent AI
   sessions in the same doc are vanishingly rare.

2. **Plate upgrade risk** — `acceptSuggestion`, `rejectSuggestion`,
   `applyAISuggestions`, `useChatChunk` are SDK APIs that could
   change shape between Plate versions. Mitigation: keep all
   Plate-specific imports in `ai-kit.tsx` + the new keymap
   component, so a future API change is a 2-file fix.

## Open questions

- **Default state for `aiReviewChanges`.** True (review by default)
  matches Track Changes muscle memory; false (auto-accept) matches
  today's behaviour. Recommend true with a one-time toast on first
  AI edit explaining the new flow.
- **Where does the pill live spatially?** Bottom-center inside the
  editor area (above the `AILoadingBar` slot) or bottom-right
  floating above the doc. Recommend bottom-center for symmetry
  with `AILoadingBar`.
- **Should the pill show during streaming?** Today's
  `AILoadingBar` is the streaming surface. The pill takes over
  on `onFinish`. Cleaner than overlapping the two.
