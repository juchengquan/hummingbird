# Conversation Branching — Part B + Viewer Test Backfill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make edit-a-user-message and regenerate-an-assistant-reply **non-destructive** by forking the thread (preserving the original) instead of truncating in place — and backfill unit tests for the already-shipped branch-tree helpers the viewer depends on.

**Architecture:** Reuse the existing `forkConversation` (add an optional title-suffix). Two pure helpers decide the fork point for edit vs regenerate. The two chat handlers are rewired to fork → continue on the fork. The branch **viewer** (dialog + `lib/shared/branches/tree.ts` + header menu) already exists and is unchanged; only its missing tests are added.

**Tech Stack:** React 19, TypeScript, Zustand, bun:test, sonner (toasts).

## Global Constraints

- **No data-model change** — `Conversation.parentId` / `forkedFromMessageId` already exist, persist, and sync. No migration, no `Database`-type change, no `STORE_VERSION` bump.
- **Do NOT rebuild the viewer.** `components/branches-dialog.tsx`, `lib/shared/branches/tree.ts`, and the `ChatHeader` "Branches" menu item are shipped and working — leave them as-is (this plan only adds the missing tests for `tree.ts`).
- Fork titles: edit → `(edit)`, regenerate → `(retry)`; the existing manual "Branch from here" button stays `(branch)` (the `titleSuffix` param defaults to `"branch"`).
- `lib/shared/*` = pure, no fence; `lib/client/*` = `import "client-only"`; components = `"use client"`.
- Tests: `bun test <path>`; new `*.test.ts` under `./lib` or `./components`. Live-store tests drive `useStore.getState()` (mirror `lib/client/hooks/store/slices/messages.test.ts`).
- Run `bun run check` before each commit; must pass.
- Commit messages: **no `Co-Authored-By` trailer**.
- The two chat handlers are NOT render-tested (no `@testing-library` in repo); the pure helpers carry the unit coverage; the wiring is verified by `bun run check` + the manual runbook.

---

## File Structure

- `lib/shared/branches/tree.test.ts` *(new)* — backfill tests for the shipped helpers. (Task 1)
- `lib/client/hooks/store/slices/conversations.ts` — add `titleSuffix` param to `forkConversation`. (Task 2)
- `lib/client/hooks/store/slices/conversations.test.ts` *(new)* — fork title-suffix test. (Task 2)
- `lib/shared/branches/fork-target.ts` *(new)* — `forkTargetForEdit` / `forkTargetForRegenerate`. (Task 3)
- `lib/shared/branches/fork-target.test.ts` *(new)* — their tests. (Task 3)
- `components/panels/chat.tsx` — rewire `handleEditUserMessage` + `handleRegenerateAssistantMessage`. (Task 4)
- `docs/SMOKE-TEST-conversation-branching.md` *(new)* — manual runbook. (Task 5)

---

## Task 1: Backfill tests for the branch-tree helpers

**Files:**
- Test: `lib/shared/branches/tree.test.ts`

> These characterize **already-shipped** code in `lib/shared/branches/tree.ts`
> (`findRoot`, `buildTree`, `countNodes`, `describeBranchPoint`). They pass
> immediately against the existing implementation — there is no red phase.
> Do NOT modify `tree.ts`.

**Interfaces:**
- Consumes: `findRoot`, `buildTree`, `countNodes`, `describeBranchPoint`, `BranchNode` from `@/shared/branches/tree`.

- [ ] **Step 1: Write the tests**

Create `lib/shared/branches/tree.test.ts`:

```typescript
import { describe, expect, it } from "bun:test"

import type { Conversation, Message } from "@/shared/types"
import {
  buildTree,
  countNodes,
  describeBranchPoint,
  findRoot,
} from "./tree"

function conv(partial: Partial<Conversation> & { id: string }): Conversation {
  return {
    workspaceId: "w1",
    title: partial.id,
    messages: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    pinned: false,
    systemPrompt: "",
    selectedFileIds: [],
    ...partial,
  }
}

function msg(id: string, content: string): Message {
  return { id, role: "user", content, timestamp: new Date("2026-01-01T00:00:00Z") }
}

describe("findRoot", () => {
  it("walks up parentId to the topmost ancestor", () => {
    const a = conv({ id: "a" })
    const b = conv({ id: "b", parentId: "a" })
    const c = conv({ id: "c", parentId: "b" })
    expect(findRoot([a, b, c], "c")?.id).toBe("a")
  })
  it("returns the node itself when it has no parent", () => {
    const a = conv({ id: "a" })
    expect(findRoot([a], "a")?.id).toBe("a")
  })
  it("falls back to the current node on broken lineage (missing parent)", () => {
    const b = conv({ id: "b", parentId: "gone" })
    expect(findRoot([b], "b")?.id).toBe("b")
  })
  it("returns null when the start id isn't present", () => {
    expect(findRoot([], "x")).toBeNull()
  })
})

describe("buildTree", () => {
  it("nests descendants and assigns depth", () => {
    const a = conv({ id: "a" })
    const b = conv({ id: "b", parentId: "a" })
    const tree = buildTree([a, b], "a")
    expect(tree?.depth).toBe(0)
    expect(tree?.children).toHaveLength(1)
    expect(tree?.children[0].conversation.id).toBe("b")
    expect(tree?.children[0].depth).toBe(1)
  })
  it("sorts children by createdAt ascending", () => {
    const a = conv({ id: "a" })
    const late = conv({ id: "late", parentId: "a", createdAt: new Date("2026-03-01T00:00:00Z") })
    const early = conv({ id: "early", parentId: "a", createdAt: new Date("2026-02-01T00:00:00Z") })
    const tree = buildTree([a, late, early], "a")
    expect(tree?.children.map((c) => c.conversation.id)).toEqual(["early", "late"])
  })
  it("returns null for a missing root", () => {
    expect(buildTree([], "nope")).toBeNull()
  })
})

describe("countNodes", () => {
  it("counts the whole tree", () => {
    const a = conv({ id: "a" })
    const b = conv({ id: "b", parentId: "a" })
    const cc = conv({ id: "c", parentId: "a" })
    const tree = buildTree([a, b, cc], "a")!
    expect(countNodes(tree)).toBe(3)
  })
})

describe("describeBranchPoint", () => {
  it("returns the first-line snippet of the branch-point message", () => {
    const parent = conv({ id: "p", messages: [msg("m1", "hello world\nsecond line")] })
    expect(describeBranchPoint(parent, "m1")).toBe("hello world")
  })
  it("truncates a long snippet to 60 chars with an ellipsis", () => {
    const long = "x".repeat(80)
    const parent = conv({ id: "p", messages: [msg("m1", long)] })
    const out = describeBranchPoint(parent, "m1")!
    expect(out.length).toBe(60)
    expect(out.endsWith("…")).toBe(true)
  })
  it("returns null for an undefined id or a missing message", () => {
    const parent = conv({ id: "p", messages: [msg("m1", "hi")] })
    expect(describeBranchPoint(parent, undefined)).toBeNull()
    expect(describeBranchPoint(parent, "gone")).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests (they pass against shipped code)**

Run: `bun test lib/shared/branches/tree.test.ts`
Expected: PASS (all). If any fail, the test encodes a wrong assumption about the shipped behavior — fix the **test**, not `tree.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/shared/branches/tree.test.ts
git commit -m "test(branches): backfill unit tests for the fork-tree helpers"
```

---

## Task 2: `forkConversation` optional `titleSuffix`

**Files:**
- Modify: `lib/client/hooks/store/slices/conversations.ts`
- Test: `lib/client/hooks/store/slices/conversations.test.ts`

**Interfaces:**
- Produces: `forkConversation(conversationId, untilMessageId, titleSuffix?) => Conversation | null`; the fork title is `` `${source.title} (${titleSuffix ?? "branch"})` ``.

- [ ] **Step 1: Write the failing test**

Create `lib/client/hooks/store/slices/conversations.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"

import { useStore } from "@/client/hooks/use-store"

describe("forkConversation titleSuffix", () => {
  test("uses the given suffix in the fork title", () => {
    const conv = useStore.getState().createConversation()
    useStore.getState().renameConversation(conv.id, "My chat")
    const msg = useStore.getState().addMessage({ role: "user", content: "hi" }, conv.id)
    const fork = useStore.getState().forkConversation(conv.id, msg.id, "edit")
    expect(fork?.title).toBe("My chat (edit)")
  })

  test("defaults to (branch) when no suffix is given", () => {
    const conv = useStore.getState().createConversation()
    useStore.getState().renameConversation(conv.id, "My chat")
    const msg = useStore.getState().addMessage({ role: "user", content: "hi" }, conv.id)
    const fork = useStore.getState().forkConversation(conv.id, msg.id)
    expect(fork?.title).toBe("My chat (branch)")
  })
})
```

(Confirm the action names by reading `conversations.ts` — `createConversation()` returns a Conversation and sets it active; `renameConversation(id, title)`; `addMessage(message, conversationId)` returns the Message. Adjust only if a name differs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/client/hooks/store/slices/conversations.test.ts`
Expected: the first test FAILS (`"My chat (branch)"` ≠ `"My chat (edit)"`); the second passes already.

- [ ] **Step 3: Implement**

In `lib/client/hooks/store/slices/conversations.ts`:

Change the interface declaration (currently
`forkConversation: (conversationId: string, untilMessageId: string) => Conversation | null`)
to:

```typescript
  forkConversation: (
    conversationId: string,
    untilMessageId: string,
    titleSuffix?: string,
  ) => Conversation | null
```

Change the implementation signature
(`forkConversation: (conversationId, untilMessageId) => {`) to:

```typescript
  forkConversation: (conversationId, untilMessageId, titleSuffix = "branch") => {
```

And change the fork's title line (currently
`` title: `${source.title} (branch)`, ``) to:

```typescript
    title: `${source.title} (${titleSuffix})`,
```

Leave everything else in the function unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/client/hooks/store/slices/conversations.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add lib/client/hooks/store/slices/conversations.ts lib/client/hooks/store/slices/conversations.test.ts
git commit -m "feat(conversations): forkConversation titleSuffix param"
```

---

## Task 3: Fork-target pure helpers

**Files:**
- Create: `lib/shared/branches/fork-target.ts`
- Test: `lib/shared/branches/fork-target.test.ts`

**Interfaces:**
- Produces:
  - `forkTargetForEdit(messages: Message[], messageId: string): string | null` — the message id to fork at when editing (the edited message itself, inclusive); null if absent.
  - `forkTargetForRegenerate(messages: Message[], assistantMessageId: string): string | null` — the nearest **preceding user** message id; null if none / not found.

- [ ] **Step 1: Write the failing test**

Create `lib/shared/branches/fork-target.test.ts`:

```typescript
import { describe, expect, it } from "bun:test"

import type { Message } from "@/shared/types"
import { forkTargetForEdit, forkTargetForRegenerate } from "./fork-target"

const t = new Date("2026-01-01T00:00:00Z")
const u = (id: string): Message => ({ id, role: "user", content: id, timestamp: t })
const a = (id: string): Message => ({ id, role: "assistant", content: id, timestamp: t })

describe("forkTargetForEdit", () => {
  it("returns the edited message id when present", () => {
    expect(forkTargetForEdit([u("u1"), a("a1")], "u1")).toBe("u1")
  })
  it("returns null when the id is absent", () => {
    expect(forkTargetForEdit([u("u1")], "gone")).toBeNull()
  })
})

describe("forkTargetForRegenerate", () => {
  it("returns the nearest preceding user message", () => {
    expect(forkTargetForRegenerate([u("u1"), a("a1")], "a1")).toBe("u1")
  })
  it("skips back over intervening assistant messages", () => {
    expect(forkTargetForRegenerate([u("u1"), a("a1"), a("a2")], "a2")).toBe("u1")
  })
  it("returns null when there is no preceding user message", () => {
    expect(forkTargetForRegenerate([a("a1")], "a1")).toBeNull()
  })
  it("returns null when the assistant id isn't found", () => {
    expect(forkTargetForRegenerate([u("u1"), a("a1")], "gone")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/shared/branches/fork-target.test.ts`
Expected: FAIL — cannot find module `./fork-target`.

- [ ] **Step 3: Implement**

Create `lib/shared/branches/fork-target.ts`:

```typescript
import type { Message } from "@/shared/types"

/** The message id to fork at when editing a user message: the edited
 *  message itself. `forkConversation` copies `[0..i]` inclusive, so the
 *  fork's last message is the edited turn. Returns null if absent. */
export function forkTargetForEdit(
  messages: Message[],
  messageId: string,
): string | null {
  return messages.some((m) => m.id === messageId) ? messageId : null
}

/** The message id to fork at when regenerating an assistant reply: the
 *  nearest preceding user message (the prompt). Forking there and
 *  resending yields a fresh reply while the original is preserved on the
 *  source. Returns null if the assistant id is absent or no user message
 *  precedes it. */
export function forkTargetForRegenerate(
  messages: Message[],
  assistantMessageId: string,
): string | null {
  const idx = messages.findIndex((m) => m.id === assistantMessageId)
  if (idx <= 0) return null
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].id
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/shared/branches/fork-target.test.ts`
Expected: PASS (6).

- [ ] **Step 5: Commit**

```bash
git add lib/shared/branches/fork-target.ts lib/shared/branches/fork-target.test.ts
git commit -m "feat(branches): fork-target helpers for edit/regenerate"
```

---

## Task 4: Rewire edit + regenerate to fork (non-destructive)

**Files:**
- Modify: `components/panels/chat.tsx`

**Interfaces:**
- Consumes: `forkConversation(…, titleSuffix)` (Task 2), `forkTargetForEdit` / `forkTargetForRegenerate` (Task 3), existing `updateMessage`, `chatSendMessage`, `toast`, the memoized `messages` (`activeConversation?.messages`).

> No render test (no harness). Verify by `bun run check` + the manual
> runbook. The destructive `truncateMessagesAfter` path is removed from
> these two handlers (it stays used elsewhere — don't remove the import
> unless it becomes unused; `bun run check` will flag an unused import).

- [ ] **Step 1: Add the import**

Near the other `@/shared` imports in `components/panels/chat.tsx`:

```typescript
import { forkTargetForEdit, forkTargetForRegenerate } from "@/shared/branches/fork-target"
```

- [ ] **Step 2: Replace `handleEditUserMessage`**

Replace the existing `handleEditUserMessage` useCallback with:

```typescript
  const handleEditUserMessage = useCallback(
    (messageId: string, newContent: string) => {
      if (!activeConversationId) return
      const target = forkTargetForEdit(messages, messageId)
      if (!target) return
      // Non-destructive: fork the thread (original preserved), then apply
      // the edit on the fork's copy of this turn and resend.
      const fork = forkConversation(activeConversationId, target, "edit")
      if (!fork) return
      const last = fork.messages[fork.messages.length - 1]
      if (!last) return
      updateMessage(last.id, newContent)
      const newHistory = [
        ...fork.messages.slice(0, fork.messages.length - 1),
        { ...last, content: newContent },
      ]
      chatSendMessage(newHistory)
      toast.success("Edited — original kept as a branch")
    },
    [activeConversationId, messages, forkConversation, updateMessage, chatSendMessage]
  )
```

- [ ] **Step 3: Replace `handleRegenerateAssistantMessage`**

Replace the existing `handleRegenerateAssistantMessage` useCallback with:

```typescript
  const handleRegenerateAssistantMessage = useCallback(
    (messageId: string) => {
      if (!activeConversationId) return
      const target = forkTargetForRegenerate(messages, messageId)
      if (!target) return
      // Non-destructive: fork at the prompting user message (original
      // reply preserved on the source) and resend for a fresh reply.
      const fork = forkConversation(activeConversationId, target, "retry")
      if (!fork) return
      chatSendMessage(fork.messages)
      toast.success("Regenerated — previous kept as a branch")
    },
    [activeConversationId, messages, forkConversation, chatSendMessage]
  )
```

- [ ] **Step 4: Verify**

Run: `bun run check`
Expected: PASS. If lint flags `truncateMessagesAfter` as now-unused, remove its `useStore` selector line + any leftover reference; if other handlers still use it (e.g. `handleRetryErrorMessage` uses `deleteMessage`, not truncate — check), leave it.

- [ ] **Step 5: Commit**

```bash
git add components/panels/chat.tsx
git commit -m "feat(chat): non-destructive edit/regenerate via fork"
```

---

## Task 5: Manual-test runbook

**Files:**
- Create: `docs/SMOKE-TEST-conversation-branching.md`

- [ ] **Step 1: Write the runbook**

Create `docs/SMOKE-TEST-conversation-branching.md`:

```markdown
# Smoke test — conversation branching (non-destructive edit/regenerate + viewer)

Manual checks for behavior the unit suite can't cover (needs a running app
+ a model). Run `bun dev`, open a chat with an AI gateway key configured.

1. [ ] **Edit is non-destructive.** Send 3+ turns. Edit an earlier **user**
   message → a new conversation titled `… (edit)` becomes active with the
   edit applied and a fresh reply; the toast reads "Edited — original kept
   as a branch"; the **original** conversation still exists intact in the
   sidebar.
2. [ ] **Regenerate is non-destructive.** On an assistant reply, click
   Regenerate → a `… (retry)` sibling becomes active with a new reply; the
   original reply is preserved on the source conversation.
3. [ ] **Branches viewer.** Open the chat header menu → **Branches**. The
   dialog shows the fork tree (root → edit/retry children) with "forked
   at: <snippet>" captions; the current node is highlighted; clicking the
   parent switches back to it.
4. [ ] **Persistence.** Reload — the branches + lineage survive (and, with
   Supabase configured, sync across devices).
5. [ ] **First-message edge.** Edit the very first user message → a fork
   with just that (edited) turn + reply; original preserved.
```

- [ ] **Step 2: Commit**

```bash
git add docs/SMOKE-TEST-conversation-branching.md
git commit -m "docs: smoke-test runbook for conversation branching"
```

---

## Final verification (after all tasks)

- [ ] `bun run check && bun run test` — typecheck + lint clean; all tests pass (the intentional `postgres unreachable` throw at `route.handler.test.ts:240` is NOT a failure).
- [ ] Manual: follow `docs/SMOKE-TEST-conversation-branching.md`.

---

## Self-Review

**Spec coverage (post-correction spec):**
- Part A viewer already shipped → not rebuilt; its missing tests backfilled → Task 1. ✓
- `forkConversation` `(edit)`/`(retry)` suffix → Task 2. ✓
- Fork-target helpers → Task 3. ✓
- Non-destructive edit (B3) + regenerate (B4), fork-based, with toasts → Task 4. ✓
- No migration/Database/STORE_VERSION change → none in any task. ✓
- Manual runbook → Task 5. ✓

**Type consistency:** `forkConversation(id, untilId, titleSuffix?)` (Task 2) is called with `"edit"` / `"retry"` in Task 4. `forkTargetForEdit(messages, messageId)` + `forkTargetForRegenerate(messages, assistantMessageId)` (Task 3) are called with the memoized `messages` in Task 4. The `Conversation`/`Message` fixtures in Tasks 1 & 3 use the real required fields (`id/workspaceId/title/messages/createdAt/updatedAt/pinned/systemPrompt/selectedFileIds`; `Message`: `id/role/content/timestamp`).

**Placeholder scan:** none — every code step carries complete code.
