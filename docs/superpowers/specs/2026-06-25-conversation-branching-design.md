# Conversation branching — viewer + non-destructive edit/regenerate — design

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — pending implementation plan

## Problem

Conversation **branching already works** but is **invisible**. The
`forkConversation` action (`lib/client/hooks/store/slices/conversations.ts`)
is complete and wired to a "Branch from here" `GitBranch` button on every
assistant message; the lineage fields `Conversation.parentId` +
`forkedFromMessageId` exist, are persisted, and sync to Supabase (the
schema, `reconcile.ts`, and `handlers.ts` already carry them). The
`parentId` doc-comment even says *"Used by the branches dialog to render
the fork tree"* — but **that dialog was never built.**

Two consequences:
1. A fork just lands in the flat sidebar titled "X (branch)" with no way
   to see what branched from what, jump to a parent, or find a
   conversation's branches.
2. **Edit a user message / regenerate an assistant reply is destructive**
   — both truncate the downstream thread in place (`updateMessage` +
   `truncateMessagesAfter` + resend). The previous version is lost.

## Goal

Make branching legible and make "redo" non-destructive, **without** a
data-model change — purely client UI + rewiring two handlers + pure
helpers:

- **A. Branch viewer** — see and navigate a conversation's fork family.
- **B. Non-destructive edit/regenerate** — preserve the old thread by
  forking instead of truncating.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Scope | Viewer **+** non-destructive edit/regenerate |
| Edit/regenerate architecture | **Fork-based** — reuse `forkConversation` (branches are whole conversations), not an in-conversation message tree |
| Viewer surface | **Branches dialog** opened from a chat-header button |
| Conversation proliferation tradeoff | **Accepted for v1** (every edit/regenerate spawns a sibling conversation; the viewer makes the family navigable; a future "prune" affordance can mitigate) |
| Branch titles | Add **`(edit)` / `(retry)`** suffixes (manual fork stays `(branch)`) |

No migration, no `Database`-type change, no `STORE_VERSION` bump — the
lineage fields already exist end to end.

## Part A — Branch viewer — ALREADY SHIPPED (correction after exploration)

**The viewer already exists end to end.** Exploration during planning found
that what this section originally proposed building is already in the
codebase (the first exploration pass missed it — it looked at the sidebar,
not the chat header):

- `lib/shared/branches/tree.ts` — pure helpers `findRoot`, `buildTree`,
  `countNodes`, `describeBranchPoint`, and the `BranchNode` type. (These
  are the real equivalents of the originally-proposed `buildBranchTree`.)
- `components/branches-dialog.tsx` — a complete indented fork-tree dialog
  with branch-point captions, click-to-switch (`setActiveConversation`),
  and a friendly empty state when the tree has < 2 nodes.
- `components/panels/chat-header.tsx` — a "Branches" item in the header
  actions menu that opens `<BranchesDialog anchorConversationId={conversation.id} />`.

**So Part A needs no new build.** The only gap on the viewer side is that
`lib/shared/branches/tree.ts` has **no unit tests** — this plan backfills
them (it's code Part B leans on). No new component, helper, or header
button is created.

## Part B — Non-destructive edit / regenerate (fork-based)

Both handlers live in `components/panels/chat.tsx`. They are rewired to
fork (preserving the original) and continue on the fork, reusing
`forkConversation` (which re-ids messages, clones the file/MCP/bookmark
joins, sets `parentId`/`forkedFromMessageId`, and switches
`activeConversationId` to the fork).

### B1. Pure fork-target helpers (`lib/shared/branching.ts`)

```ts
/** The message id to fork at when editing the user message `messageId`:
 *  the edited message itself (fork copies [0..i] inclusive, then the
 *  fork's copy of that message is edited + resent). null if not found. */
export function forkTargetForEdit(messages: Message[], messageId: string): string | null

/** The message id to fork at when regenerating the assistant message
 *  `messageId`: the nearest preceding user message (the prompt). null if
 *  none (e.g. assistant with no preceding user turn). */
export function forkTargetForRegenerate(messages: Message[], messageId: string): string | null
```

Both pure → unit-tested (incl. edge cases: editing the first message;
regenerating the reply to the first user message; ids not present).

### B2. `forkConversation` — optional title suffix

Add an optional third param so callers can label the fork:

```ts
forkConversation: (
  conversationId: string,
  untilMessageId: string,
  titleSuffix?: string,   // default "branch"
) => Conversation | null
```

The title becomes `` `${source.title} (${titleSuffix ?? "branch"})` ``.
Backward-compatible — existing callers (the manual "Branch from here"
button) keep `(branch)`.

### B3. Edit handler (rewired)

`handleEditUserMessage(messageId, newContent)`:
1. `const target = forkTargetForEdit(messages, messageId)` (the edited
   message id). Bail if null.
2. `const fork = forkConversation(activeId, target, "edit")`. The fork is
   `[0..i]` (original content) and is now active.
3. The fork's **last** message corresponds to the edited user turn —
   `updateMessage(fork.messages.at(-1).id, newContent)`.
4. `chatSendMessage(<fork history with the edited content>)`.
5. Toast: *"Edited — original kept as a branch"*.

The original conversation is untouched.

### B4. Regenerate handler (rewired)

`handleRegenerateAssistantMessage(assistantMessageId)`:
1. `const target = forkTargetForRegenerate(messages, assistantMessageId)`
   (the preceding user message). Bail if null.
2. `const fork = forkConversation(activeId, target, "retry")` — fork is
   `[0..userMsg]`, now active.
3. `chatSendMessage(<fork history>)` to produce a fresh reply.
4. Toast: *"Regenerated — previous kept as a branch"*.

The original keeps the old reply.

## Data flow

```
edit/regenerate
  └─ forkTargetFor{Edit,Regenerate}(messages, id) → targetMsgId
        └─ forkConversation(activeId, targetMsgId, "edit"|"retry")
              → new conversation (lineage set, becomes active, original intact)
                 └─ [edit only] updateMessage(fork last msg, newContent)
                    └─ chatSendMessage(fork history)   → new reply on the fork

view branches
  └─ header button (shown if parent or children exist)
        └─ BranchesDialog → buildBranchTree(conversations, activeId)
              → click node → setActiveConversation(id)
```

## Error handling / edges

- `buildBranchTree` returns `null` (no button/dialog) when the active
  conversation is missing; dangling `parentId` → that node is a root (no
  orphan crash).
- Editing the first message / regenerating the first reply → the
  fork-target helpers return the first message / first user message; the
  fork is the minimal prefix. Covered by tests.
- If `forkConversation` returns `null` (source/target missing), the
  handler no-ops (no destructive fallback) and shows no toast.
- Existing destructive behavior is fully replaced for edit/regenerate;
  the manual "Branch from here" button is unchanged.

## Testing

- **`lib/shared/branches/tree.ts`** (backfill — code already shipped) —
  `findRoot` (walk up a chain, broken-lineage fallback, cycle guard),
  `buildTree` (descendant nesting, children sorted by createdAt, missing
  root → null), `countNodes`, `describeBranchPoint` (first-line snippet,
  truncation, missing/absent message → null). Unit (pure).
- **`forkTargetForEdit` / `forkTargetForRegenerate`** — normal case, first
  message, missing id, assistant-with-no-preceding-user. Unit (pure).
- **`forkConversation` suffix** — title uses the suffix; default stays
  "branch". Extend the existing conversations-slice test (live store).
- **`BranchesDialog` + the two handlers** — not render-tested (no
  `@testing-library` in the repo). Verified by review + a new manual step
  appended to a runbook (`docs/SMOKE-TEST-conversation-branching.md`).

## Manual verification

In a chat: send a few turns; **edit** an earlier user message → confirm a
new "(edit)" conversation becomes active with the edit applied, and the
**original** still exists intact in the sidebar. **Regenerate** an
assistant reply → confirm a "(retry)" sibling, original preserved. Open
the **Branches** header button → the dialog shows the family tree; click
the parent → switches back to it. Reload → lineage + branches persist.

## Out of scope (v1)

- In-conversation message-tree variants (the ChatGPT-style inline `‹2/3›`
  arrows) — explicitly not chosen; branches stay whole conversations.
- Nested-tree rendering in the main sidebar (the dialog covers navigation).
- Pruning/merging branches, or a "branch vs overwrite" choice on edit
  (edit/regenerate are non-destructive by default now).
