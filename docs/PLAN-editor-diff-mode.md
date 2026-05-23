# Plan: Diff mode for editor AI commands

Status: **planning** — no code yet.

When the rich-text editor's AI command (`/api/ai/command`) modifies
the document, instead of applying changes in-place, snapshot the
pre-change content and render a before/after diff with per-chunk
**Accept / Reject** affordances — like a PR review for chat-driven
writing.

Builds on the existing AI command flow (`components/editor/use-chat.ts`
+ `app/api/ai/command/route.ts`) and the in-place AI menu surface
(`components/ui/ai-menu.tsx`).

## Why

Today the editor AI is "ask, get a result, hope it's right." If it
overwrites a paragraph the user wrote carefully, they have to discard
the whole thing and re-prompt — there's no granular escape hatch. A
diff mode lets the user keep the parts that landed well, reject the
parts that didn't, and re-prompt the rejected sections without
losing the wins.

This is also where AI writing tools start to feel like a collaboration
rather than a slot machine: the user is reviewing the model's edits,
not gambling on whether to overwrite their draft.

## Goal & scope cuts

**v1 ships:**

- Diff mode applies to `edit` operations only (the AI menu's
  "Improve selection" / "Continue writing" flows that today rewrite
  in place). `generate` (insert-only into an empty block) and
  `comment` (sidebar annotation) keep their current behaviour —
  there's nothing to diff against.
- Triggered by an opt-in **"Review changes"** toggle on the AI menu,
  default ON. Power users who want today's blast-replace UX can
  flip it off per-prompt. (Persisting the toggle across sessions is
  v1 polish — store in `useStore` next to other editor prefs.)
- **Diff surface: inline Track Changes** (Word / Google Docs style).
  Additions render in green underline, deletions in red strikethrough,
  in the doc itself at normal width. Hovering any change reveals a
  floating action chip with **✓ Accept / ✕ Reject / ↻ Regenerate**.
  No split-view, no side panel — the doc stays at its normal
  width, which is critical for mobile and narrow editor columns.
- **Granularity: paragraph / block-level for accept/reject**;
  word-level highlights for *reading* the change. Slate's data
  model is a tree of nodes — splitting a paragraph mid-text-run
  into "accept this word, reject that word" cascades into "what
  if the user already had marks here." Block-level keeps the
  invariants clean; the inline highlights are decoration.
- **Review bar** anchored bottom-center while review is active:
  shows "N AI changes pending" + `Accept all` / `Reject all` /
  `Done` controls. Mirrors the existing `AILoadingBar` placement.
- **Keyboard:** `Tab` / `Shift+Tab` move focus to next / previous
  pending change; `Y` accepts the focused one, `N` rejects it,
  `⌘↵` accepts-all-and-dismisses, `Esc` rejects-all-and-dismisses.
- One-click `Accept all` / `Reject all` for the common case where
  the user just wants the whole rewrite (or doesn't).

**Cut from v1 to keep it shippable:**

- **`generate` and `comment` flows.** Out of scope. Different UX
  shapes; revisit once `edit` mode is proven.
- **Word-level accept/reject.** Slate's data model is tree-of-nodes;
  doing sub-paragraph cuts means splitting nodes mid-text-run, which
  cascades into "what if the user already had marks here." Block-
  level is the right v1 granularity.
- **Replaying rejected chunks against a new prompt.** Cute idea
  ("regenerate the rejected paragraph only"), but it needs a per-
  chunk prompt + the model's prior context — significant added
  scope. Defer.
- **Diff history view.** Once accepted, the change is just an
  edit. No "show me what the AI suggested last week." Editor
  already has its own document history surface if needed.
- **Diff for AI commands invoked from outside the AI menu** (e.g. a
  future "suggest next paragraph" plugin). Same surface should work
  generically, but v1 only wires the existing AI menu.

## UX shape — why Track Changes over split-view

Three layouts were considered:

1. **Inline split-view.** Each block becomes a two-column row in
   the doc — original on the left, proposed on the right, action
   buttons between. Unambiguous but doubles vertical space, and
   wrecks the editor at mobile widths (a 640 px column → two
   280 px columns is unusable).
2. **Track Changes inline (chosen).** Word / Google Docs pattern.
   Proposed text replaces original inline; additions in green,
   deletions in red strikethrough; hover chip carries the
   actions. Doc keeps its normal width. Familiar to every writer.
   Maps cleanly onto Slate's existing decoration / mark system.
3. **Side panel.** Right-rail with a code-review-style hunk view;
   doc unchanged until accept. Rejected because the editor *is*
   the work surface — putting the diff next to it disconnects
   "review" from "where I'm reading."

The hard cost of Track Changes is dense changes (every other word
rewritten) — the red/green interleave can get noisy. Addressed
via the per-chip eye-toggle described under "Edge cases."

## Surface architecture

### Three integration points

The Plate AI plugin's streaming mutations are **opaque to us** —
`streamInsertChunk()` and `applyAISuggestions()` from `@platejs/ai/react`
are called by `components/editor/plugins/ai-kit.tsx` via the
`useChatChunk` hook, and they mutate the editor in place as chunks
arrive. We can't insert ourselves between "model output" and "editor
mutation" without forking the Plate AI plugin.

The cleanest interception is at the **boundary either side of those
calls**:

**Snapshot before:** in `components/editor/plugins/ai-kit.tsx`, at
the start of `useChatChunk`'s `onChunk` for the first incoming chunk
of an `edit` operation, clone `editor.children` into a local snapshot.
This is a one-liner `JSON.parse(JSON.stringify(editor.children))` (or
`structuredClone` — Slate values are JSON-safe). Store the snapshot
in a new piece of Plate plugin state, keyed by the in-flight AI
command id.

**Capture after:** when the stream finishes (in `useChatChunk`'s
`onFinish`, or the equivalent), the editor's current `editor.children`
is the "after" state. Pair it with the snapshot.

**Render the review UI:** before the existing `AILoadingBar` shows
its Accept/Discard buttons, route through a new
`AIDiffReviewBar` (or expand the loading bar) that renders the diff.
Per-chunk Accept keeps the corresponding "after" node; Reject swaps
it back to the snapshot's node.

### How the inline Track Changes view renders

During review, both the **proposed** node and the **original** node
for each `replaced` chunk are present in the editor — the original
hidden as a Slate decoration carrying a `kind: "ai-remove"` mark,
the proposed as `kind: "ai-add"`. Plate's decoration system already
supports per-leaf rendering, so a renderer plugin paints:

- `ai-add` marks → `text-emerald-700` + light green underline
- `ai-remove` marks → `text-red-700` + strikethrough, slightly dimmed
- Hovering or focusing a change → floating chip with action buttons
- `added` / `removed` whole-block chunks → the entire block carries
  the corresponding mark, so the block reads as one continuous
  green-added or red-strikethrough region

For inline highlighting *within* a replaced paragraph (word-level
green / red), `fast-diff` runs on the leaf text of the before /
after pair; the result becomes a list of `{ text, kind: 'unchanged'
| 'add' | 'remove' }` segments which the decoration plugin paints.
The accept/reject verdict still acts on the whole block — these
are just visual cues that help the user read the change.

### Three new components

**`components/editor/ai-diff-decoration.tsx`** — the Plate decoration
plugin that paints `ai-add` / `ai-remove` marks and renders the
hover chip. The chip is anchored to the changed range via Plate's
existing range-anchored positioning (same trick `ai-menu.tsx`
already uses).

**`components/editor/ai-diff-chip.tsx`** — the floating per-change
action chip: `✓ Accept`, `✕ Reject`, `↻ Regenerate`, with `⌘E`
keyboard hint. Appears on hover, focus, or after `Tab`-navigation
brings the change into focus.

**`components/editor/ai-diff-review-bar.tsx`** — replaces / extends
the existing `AILoadingBar`. Bottom-center pill with "N AI changes
pending", `Accept all`, `Reject all`, `Done`. "Done" is enabled
once every chunk has a verdict (or after a single `Accept all`).

### One new pure-logic module

**`lib/client/editor/diff-blocks.ts`** — computes the per-block diff
between two Slate value arrays. Pure function:

```ts
export type BlockDiffChunk =
  | { kind: 'unchanged'; node: SlateNode }
  | { kind: 'added';     node: SlateNode; afterIndex: number }
  | { kind: 'removed';   node: SlateNode; beforeIndex: number }
  | { kind: 'replaced';  before: SlateNode; after: SlateNode }

export function diffBlocks(before: SlateNode[], after: SlateNode[]): BlockDiffChunk[]
```

Implementation: an LCS-based diff on a hash of each node's serialized
text content. `fast-diff` (~3 KB) is the cheap dependency we'd add;
LCS-on-array isn't worth handrolling.

For inline text highlights within a `replaced` chunk, run `fast-diff`
on the leaf text of `before.node` vs `after.node` and render the
result inline. This is decoration, not logic — the accept/reject
verdict still acts on the whole block.

## Edge cases

- **Multi-block edits.** AI rewrites a 3-paragraph selection into
  2 paragraphs. The diff is `[replaced, replaced, removed]` or
  similar. Each chunk gets its own accept/reject. "Accept all" or
  "Reject all" handles the common case in one click.
- **Dense changes (every other word rewritten).** Interleaved
  red-strikethrough + green-underline can get noisy to parse. The
  hover chip on each change includes a tiny eye-toggle that
  briefly hides removals (showing only the proposed text) or
  hides additions (showing only the original). Cheap to add as a
  per-chip toggle on the existing decoration plugin — not in v1
  critical path but recorded here.
- **Stream still running when user clicks Accept on an early
  chunk.** Either disable per-chunk buttons until `onFinish`, or
  accept the in-flight value (which may still change). v1: disable
  until finish — simpler, and the AI menu already has a "wait for
  finish" state.
- **AI command aborted mid-stream.** Revert to the snapshot,
  exactly as the existing Discard button does today. No diff to
  show.
- **Snapshot grows large.** Editor docs are usually < 100 KB. A
  full-doc clone per AI invocation is fine. If users start hitting
  giant docs (book-length), consider scoping the snapshot to the
  Slate `selection` range; v1 keeps it simple.
- **User edits the doc manually while the diff review pane is
  open.** Lock the editor to read-only while review is active.
  Reuses Plate's `editor.api.readOnly()` flag.
- **Plate's internal AI undo stack.** The AI plugin tracks its own
  undo (`editor.getTransforms(AIPlugin).ai.undo()` in
  `ai-menu.tsx`). On Reject-all + close, call this — keeps the
  rest of the codebase unaware. On Accept-all + close, just clear
  the snapshot.

## Feasibility assessment

**Verdict: feasible, but with one structural friction.**

The friction is that Plate's AI plugin streams mutations into the
editor in-place. We don't have a clean "diff before applying"
chokepoint — only "snapshot before, observe after." That works, but
it means the user briefly sees the AI's output applied to their doc
before the diff review pane opens. Visually we can paper over this
with a fade or by holding the read-only state from "stream start"
through "review accepted," but it's worth knowing the AI's edits
*do* hit the live editor before review.

Two alternatives I considered and rejected:

1. **Run the AI to a hidden Plate instance, diff against the main
   one, swap on Accept.** Cleaner UX (no flash of model output in
   the live doc) but doubles the editor's lifecycle complexity and
   has to keep the hidden instance's selection / marks /
   collaboration state in sync. Too much for v1.
2. **Fork `@platejs/ai/react` to add an `onBeforeMutate` callback.**
   Cleanest possible answer, but binds us to maintaining the fork.
   Defer until we have a second reason to fork.

Going with snapshot-and-observe — the "flash" is a small cosmetic
issue and the implementation stays cheap.

## Files touched

| File | Why |
|---|---|
| `components/editor/plugins/ai-kit.tsx` | Snapshot on chunk-start, hand off to review UI on finish |
| `components/editor/ai-diff-decoration.tsx` *(new)* | Plate decoration plugin painting `ai-add` / `ai-remove` marks |
| `components/editor/ai-diff-chip.tsx` *(new)* | Floating per-change action chip |
| `components/editor/ai-diff-review-bar.tsx` *(new)* | Accept-all / Reject-all / Done controls + change counter |
| `lib/client/editor/diff-blocks.ts` *(new)* | Pure block-level diff function |
| `lib/client/editor/diff-blocks.test.ts` *(new)* | Unit tests on the diff function |
| `components/ui/ai-menu.tsx` | Add "Review changes" toggle, default on |
| `lib/client/hooks/use-store.ts` | Persist the toggle pref |
| `package.json` | Add `fast-diff` dependency (~3 KB) |

**~350 lines** of new code, ~80 of tests. Smaller than the
split-view design because the decoration plugin reuses Plate's
existing mark-rendering pipeline instead of a custom two-column
layout. The diff function is small once `fast-diff` does the LCS
work.

## Test plan

- **`diff-blocks.test.ts`** *(new, ~15 cases):*
  - Identical inputs → all chunks `unchanged`
  - Single block replaced → one `replaced` chunk
  - Block deleted → one `removed`, rest `unchanged`
  - Block added → one `added`, rest `unchanged`
  - Multi-block replace with order changes (paragraph reordered)
  - Empty before / empty after
- **Manual UX**: invoke the AI menu's edit-selection on a paragraph,
  observe the review pane appears, per-chunk accept/reject works,
  Esc reverts, Accept-all keeps everything, doc state matches
  expected outcome in both verdicts.
- Existing 250+ tests stay green.

## Risk

**Medium.** The implementation is contained, but it depends on
Plate AI plugin internals (the `useChatChunk` hook contract,
`editor.children` semantics during streaming) that we don't own. A
Plate upgrade could move these out from under us. Mitigation:
write a small abstraction layer (`lib/client/editor/ai-diff-bridge.ts`)
that wraps the Plate-specific bits, so a future Plate API change is
a one-file fix.

## Open questions

- **Read-only during stream + review: full-doc or scoped?** Full-doc
  read-only is simpler. Scoped (only the affected blocks) is more
  user-friendly — they can keep editing elsewhere in the doc — but
  requires Plate path-based selection locking, which isn't well-
  trodden. Recommend v1 = full-doc read-only, revisit if it bites.
- **Where does the "Review changes" toggle persist?** Per-user in
  `useStore.editorPrefs`, or always default-on? Recommend persist
  per-user; gives power users a single off-switch.
- **What happens to existing in-flight AI commands when a user
  toggles "Review changes" mid-stream?** Take the value at the
  moment the command started. Don't apply mid-stream toggle changes.
