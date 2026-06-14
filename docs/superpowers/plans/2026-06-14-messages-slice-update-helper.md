# Messages-Slice `updateMessage` Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a pure `updateMessage(state, messageId, patch)` helper (and a sibling `removeMessage(state, messageId)`) into `lib/client/hooks/store-helpers.ts`. Rewrite the 17 per-message mutators in `lib/client/hooks/store/slices/messages.ts` to call the helper. No behaviour change.

**Architecture:** Two pure helpers in the existing `store-helpers.ts` (no new module). Each mutator in the messages slice collapses from a 6-line `conversations.map` dance to a one-line `set((s) => updateMessage(s, messageId, (m) => ({...m, foo})))`. The "find owning conversation across ALL conversations" invariant lives once. New describes in `store-helpers.test.ts` pin the helper contract. The persisted shape + `STORE_VERSION` are untouched.

**Tech Stack:** TypeScript 5.x, bun:test, Zustand 5. No new deps.

---

## File Structure

| File | Change |
|---|---|
| `lib/client/hooks/store-helpers.ts` | MOD — add `updateMessage` + `removeMessage` exports |
| `lib/client/hooks/store-helpers.test.ts` | MOD — add 2 describes (one per helper) |
| `lib/client/hooks/store/slices/messages.ts` | MOD — rewrite 17 mutators using the helpers |

No state-shape change. No new types. No persistence contract change.

---

## Task 1: Add `updateMessage` + tests

**Files:**
- Modify: `lib/client/hooks/store-helpers.ts` (append at end of file)
- Modify: `lib/client/hooks/store-helpers.test.ts` (append describe)

- [ ] **Step 1: Add `updateMessage` to `store-helpers.ts`**

Append at the end of `lib/client/hooks/store-helpers.ts`:

```ts
import type { Conversation, Message } from "@/shared/types"

// --- messages reducer ------------------------------------------------------

/**
 * Apply `patch` to the message identified by `messageId` across every
 * conversation in `state.conversations`. Returns a `Partial<S>` that
 * can be returned from a Zustand `set` updater.
 *
 * INVARIANT: searches ALL conversations, not just the active one.
 * Message ids are uuids and uniquely identify the owning conversation.
 * Filtering on `activeConversationId` here would misfire whenever the
 * user has switched tabs since the message was created — particularly
 * during parallel streams.
 *
 * No-op when no message matches: returns `{}` so Zustand skips the
 * re-render. Identity-preserving when the patch produces a value-equal
 * message (the conversation reference is unchanged).
 */
export function updateMessage<
  S extends { conversations: Conversation[] },
>(
  state: S,
  messageId: string,
  patch: (m: Message) => Message,
): Partial<S> {
  let touched = false
  const conversations = state.conversations.map((c) => {
    if (!c.messages.some((m) => m.id === messageId)) return c
    touched = true
    const nextMessages = c.messages.map((m) =>
      m.id === messageId ? patch(m) : m,
    )
    if (nextMessages.every((m, i) => m === c.messages[i])) {
      return c
    }
    return { ...c, messages: nextMessages }
  })
  if (!touched) return {}
  return { conversations } as Partial<S>
}
```

(Place the import at the top with the other type imports.)

- [ ] **Step 2: Add the test describe**

Append to `lib/client/hooks/store-helpers.test.ts`:

```ts
import {
  updateMessage,
  removeMessage,
} from "./store-helpers"
import type { Conversation, Message } from "@/shared/types"

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    role: "user",
    content: "hello",
    timestamp: new Date(),
    ...overrides,
  }
}

function makeState(
  conversations: Conversation[],
  extras: Record<string, unknown> = {},
) {
  return { conversations, ...extras }
}

describe("updateMessage", () => {
  test("patches the message across all conversations", () => {
    const m = makeMessage({ id: "m1", content: "old" })
    const state = makeState([
      {
        id: "conv-1",
        title: "C1",
        messages: [m],
        createdAt: new Date(),
        updatedAt: new Date(),
        pinned: false,
      },
    ])
    const result = updateMessage(state, "m1", (mm) => ({
      ...mm,
      content: "new",
    }))
    expect(result.conversations?.[0].messages[0].content).toBe("new")
  })

  test("no-op when no message matches → returns {}", () => {
    const state = makeState([
      {
        id: "conv-1",
        title: "C1",
        messages: [makeMessage({ id: "m1" })],
        createdAt: new Date(),
        updatedAt: new Date(),
        pinned: false,
      },
    ])
    const result = updateMessage(state, "m2", (m) => ({ ...m, content: "x" }))
    expect(result).toEqual({})
  })

  test("identity-preserving no-op → returns {}", () => {
    const m = makeMessage({ id: "m1", content: "same" })
    const state = makeState([
      {
        id: "conv-1",
        title: "C1",
        messages: [m],
        createdAt: new Date(),
        updatedAt: new Date(),
        pinned: false,
      },
    ])
    const result = updateMessage(state, "m1", (mm) => mm)
    expect(result).toEqual({})
  })

  test("searches across ALL conversations, not just active", () => {
    const m = makeMessage({ id: "m1", content: "old" })
    const state = makeState([
      {
        id: "conv-1",
        title: "C1",
        messages: [m],
        createdAt: new Date(),
        updatedAt: new Date(),
        pinned: false,
      },
      {
        id: "conv-2",
        title: "C2",
        messages: [makeMessage({ id: "m2", content: "stays" })],
        createdAt: new Date(),
        updatedAt: new Date(),
        pinned: false,
      },
    ])
    const result = updateMessage(state, "m1", (mm) => ({
      ...mm,
      content: "new",
    }))
    expect(result.conversations?.[0].messages[0].content).toBe("new")
    expect(result.conversations?.[1].messages[0].content).toBe("stays")
  })

  test("composes with sibling fields via Partial<S>", () => {
    const state = makeState(
      [
        {
          id: "conv-1",
          title: "C1",
          messages: [makeMessage({ id: "m1" })],
          createdAt: new Date(),
          updatedAt: new Date(),
          pinned: false,
        },
      ],
      { notes: [] as Array<{ id: string }> },
    )
    const result = {
      ...updateMessage(state, "m1", (m) => ({ ...m, content: "x" })),
      notes: [{ id: "n1" }],
    }
    expect(result.conversations?.[0].messages[0].content).toBe("x")
    expect(result.notes).toEqual([{ id: "n1" }])
  })
})
```

- [ ] **Step 3: Run the new tests**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/hooks/store-helpers.test.ts`
Expected: PASS, with the new `describe("updateMessage")` block passing.

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store-helpers.ts lib/client/hooks/store-helpers.test.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(store): add updateMessage helper + tests

Pure helper lifts the 'find owning conversation across ALL convos'
invariant from 17 mutators. Identity-preserving no-op is a strict
refinement of today's behaviour (which always allocates a new
conversation reference even when the patch is identity).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `removeMessage` + tests

**Files:**
- Modify: `lib/client/hooks/store-helpers.ts` (append after `updateMessage`)
- Modify: `lib/client/hooks/store-helpers.test.ts` (append describe)

- [ ] **Step 1: Add `removeMessage`**

Append after `updateMessage`:

```ts
/**
 * Remove the message identified by `messageId` from whichever
 * conversation owns it. Returns a `Partial<S>` with `conversations`
 * updated, or `{}` when no message matches.
 *
 * Mirrors `updateMessage`'s invariants: searches ALL conversations,
 * identity-preserving no-op when the message is not found.
 */
export function removeMessage<
  S extends { conversations: Conversation[] },
>(
  state: S,
  messageId: string,
): Partial<S> {
  let touched = false
  const conversations = state.conversations.map((c) => {
    if (!c.messages.some((m) => m.id === messageId)) return c
    touched = true
    return { ...c, messages: c.messages.filter((m) => m.id !== messageId) }
  })
  if (!touched) return {}
  return { conversations } as Partial<S>
}
```

- [ ] **Step 2: Add the test describe**

Append after the `updateMessage` describe:

```ts
describe("removeMessage", () => {
  test("removes the message from the owning conversation", () => {
    const state = makeState([
      {
        id: "conv-1",
        title: "C1",
        messages: [
          makeMessage({ id: "m1" }),
          makeMessage({ id: "m2" }),
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
        pinned: false,
      },
    ])
    const result = removeMessage(state, "m1")
    expect(result.conversations?.[0].messages).toHaveLength(1)
    expect(result.conversations?.[0].messages[0].id).toBe("m2")
  })

  test("no-op when no message matches → returns {}", () => {
    const state = makeState([
      {
        id: "conv-1",
        title: "C1",
        messages: [makeMessage({ id: "m1" })],
        createdAt: new Date(),
        updatedAt: new Date(),
        pinned: false,
      },
    ])
    expect(removeMessage(state, "m2")).toEqual({})
  })

  test("preserves conversation order", () => {
    const state = makeState([
      {
        id: "conv-1",
        title: "C1",
        messages: [
          makeMessage({ id: "m1" }),
          makeMessage({ id: "m2" }),
          makeMessage({ id: "m3" }),
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
        pinned: false,
      },
    ])
    const result = removeMessage(state, "m2")
    expect(result.conversations?.[0].messages.map((m) => m.id)).toEqual([
      "m1",
      "m3",
    ])
  })

  test("returns Partial<S> that composes with siblings", () => {
    const state = makeState(
      [
        {
          id: "conv-1",
          title: "C1",
          messages: [makeMessage({ id: "m1" })],
          createdAt: new Date(),
          updatedAt: new Date(),
          pinned: false,
        },
      ],
      { notes: [{ id: "n1", messageId: "m1" as string | null }] },
    )
    const result = {
      ...removeMessage(state, "m1"),
      notes: state.notes.map((n) =>
        n.messageId === "m1" ? { ...n, messageId: null } : n,
      ),
    }
    expect(result.conversations?.[0].messages).toHaveLength(0)
    expect(result.notes[0].messageId).toBeNull()
  })
})
```

- [ ] **Step 3: Run the new tests**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/hooks/store-helpers.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store-helpers.ts lib/client/hooks/store-helpers.test.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(store): add removeMessage helper + tests

Symmetric with updateMessage. Used by the deleteMessage mutator
(which also runs the cross-entity notes/artifacts cascade).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rewrite the simple mutators

**Files:**
- Modify: `lib/client/hooks/store/slices/messages.ts`

This task covers the 13 mutators that have no special cases (no idempotency, no sub-array append, no cross-entity cascade, no perf marks). Each mutator body collapses to one line via `set((s) => updateMessage(s, messageId, (m) => ({...m, key: value})))`.

- [ ] **Step 1: Rewrite `updateMessage` mutator**

Find the existing `updateMessage` mutator (lines 174-187) and replace with:

```ts
updateMessage: (messageId, content) =>
  set((state) => updateMessage(state, messageId, (m) => ({ ...m, content }))),
```

- [ ] **Step 2: Rewrite `setMessageReasoningDuration`**

Find the existing mutator (lines 296-311) and replace with:

```ts
setMessageReasoningDuration: (messageId, durationMs) =>
  set((state) =>
    updateMessage(state, messageId, (m) => ({
      ...m,
      reasoningDurationMs: durationMs,
    })),
  ),
```

- [ ] **Step 3: Rewrite `setMessageToolCalls`**

Find the existing mutator (lines 312-327) and replace with:

```ts
setMessageToolCalls: (messageId, toolCalls) =>
  set((state) =>
    updateMessage(state, messageId, (m) => ({
      ...m,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    })),
  ),
```

- [ ] **Step 4: Rewrite `setMessageSuggestions`**

Find the existing mutator (lines 328-341) and replace with:

```ts
setMessageSuggestions: (messageId, suggestions) =>
  set((state) =>
    updateMessage(state, messageId, (m) => ({ ...m, suggestions })),
  ),
```

- [ ] **Step 5: Rewrite `setMessageVerification`**

Find the existing mutator (lines 342-355) and replace with:

```ts
setMessageVerification: (messageId, verification) =>
  set((state) =>
    updateMessage(state, messageId, (m) => ({ ...m, verification })),
  ),
```

- [ ] **Step 6: Rewrite `setMessageRoutedModel`**

Find the existing mutator (lines 356-369) and replace with:

```ts
setMessageRoutedModel: (messageId, modelId) =>
  set((state) =>
    updateMessage(state, messageId, (m) => ({ ...m, routedModel: modelId })),
  ),
```

- [ ] **Step 7: Rewrite `setMessageError`**

Find the existing mutator (lines 488-501) and replace with:

```ts
setMessageError: (messageId, error) =>
  set((state) => updateMessage(state, messageId, (m) => ({ ...m, error }))),
```

- [ ] **Step 8: Rewrite `clearMessageError`**

Find the existing mutator (lines 502-518) and replace with:

```ts
clearMessageError: (messageId) =>
  set((state) => {
    const updated = updateMessage(state, messageId, (m) => {
      const { error: _ignored, ...rest } = m
      void _ignored
      return rest
    })
    // If no message matched, also clear nothing — the no-op sentinel
    // is preserved by updateMessage returning {}.
    if (Object.keys(updated).length === 0) return {}
    return updated
  }),
```

- [ ] **Step 9: Add the `updateMessage` import**

Add to the top of `lib/client/hooks/store/slices/messages.ts`:

```ts
import { updateMessage } from "../store-helpers"
```

- [ ] **Step 10: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS.

- [ ] **Step 11: Run tests**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test`
Expected: PASS (the rewritten mutators produce the same state diffs as before).

- [ ] **Step 12: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store/slices/messages.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(messages-slice): rewrite 8 simple mutators via updateMessage

updateMessage, setMessageReasoningDuration, setMessageToolCalls,
setMessageSuggestions, setMessageVerification, setMessageRoutedModel,
setMessageError, clearMessageError — each mutator body collapses
from a 6-line conversations.map dance to a one-liner.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Rewrite the sub-array append mutators

**Files:**
- Modify: `lib/client/hooks/store/slices/messages.ts`

This task covers the 4 mutators that append to a sub-array on the message (with idempotency on the part id): `appendMessageGeneratedImages`, `appendMessageUiPart`, `appendMessageMcpApp`, `replaceMessageMcpAppHtml`.

- [ ] **Step 1: Rewrite `appendMessageGeneratedImages`**

Find the existing mutator (lines 370-383) and replace with:

```ts
appendMessageGeneratedImages: (messageId, images) =>
  set((state) =>
    updateMessage(state, messageId, (m) => ({
      ...m,
      generatedImages: [...(m.generatedImages ?? []), ...images],
    })),
  ),
```

- [ ] **Step 2: Rewrite `appendMessageUiPart`**

Find the existing mutator (lines 384-401) and replace with:

```ts
appendMessageUiPart: (messageId, part) =>
  set((state) =>
    updateMessage(state, messageId, (m) => {
      const existing = m.uiParts ?? []
      if (existing.some((p) => p.id === part.id)) return m
      return { ...m, uiParts: [...existing, part] }
    }),
  ),
```

- [ ] **Step 3: Rewrite `appendMessageMcpApp`**

Find the existing mutator (lines 402-416) and replace with:

```ts
appendMessageMcpApp: (messageId, part) =>
  set((state) =>
    updateMessage(state, messageId, (m) => {
      const existing = m.mcpApps ?? []
      if (existing.some((p) => p.id === part.id)) return m
      return { ...m, mcpApps: [...existing, part] }
    }),
  ),
```

- [ ] **Step 4: Rewrite `replaceMessageMcpAppHtml`**

Find the existing mutator (lines 417-438) and replace with:

```ts
replaceMessageMcpAppHtml: (messageId, partId, html) =>
  set((state) =>
    updateMessage(state, messageId, (m) => {
      const existing = m.mcpApps ?? []
      if (!existing.some((p) => p.id === partId)) return m
      return {
        ...m,
        mcpApps: existing.map((p) =>
          p.id === partId ? { ...p, html, truncated: undefined } : p,
        ),
      }
    }),
  ),
```

- [ ] **Step 5: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store/slices/messages.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(messages-slice): rewrite 4 sub-array append mutators

appendMessageGeneratedImages, appendMessageUiPart,
appendMessageMcpApp, replaceMessageMcpAppHtml — idempotency-on-part-id
logic preserved; the helper absorbs the outer 'find owning conv' scan.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Rewrite the perf-marker mutators

**Files:**
- Modify: `lib/client/hooks/store/slices/messages.ts`

This task covers `appendToMessage` and `appendToMessageReasoning`. They wrap the same shape but bracket the work in `perfMark`/`perfCount` calls (one at the slice boundary, one inside `set` to measure the state-update cost).

- [ ] **Step 1: Rewrite `appendToMessage`**

Find the existing mutator (lines 252-272) and replace with:

```ts
appendToMessage: (messageId, chunk) => {
  perfMark("humm/chat/append-message:start")
  perfCount("chat.append.message")
  set((state) => {
    const next = updateMessage(state, messageId, (m) => ({
      ...m,
      content: m.content + chunk,
    }))
    perfMark("humm/chat/append-message:end")
    return next
  })
},
```

- [ ] **Step 2: Rewrite `appendToMessageReasoning`**

Find the existing mutator (lines 273-295) and replace with:

```ts
appendToMessageReasoning: (messageId, chunk) => {
  perfMark("humm/chat/append-reasoning:start")
  perfCount("chat.append.reasoning")
  set((state) => {
    const next = updateMessage(state, messageId, (m) => ({
      ...m,
      reasoning: (m.reasoning ?? "") + chunk,
    }))
    perfMark("humm/chat/append-reasoning:end")
    return next
  })
},
```

- [ ] **Step 3: Run `bun run check` + tests**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check && cd /Users/blackmount8/_repository/hummingbird && bun run test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store/slices/messages.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(messages-slice): rewrite appendToMessage + appendToMessageReasoning via helper

Perf marks preserved (start outside set, end inside set). Both
mutators shrink from 20+ lines to ~10.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Rewrite the two remaining mutators

**Files:**
- Modify: `lib/client/hooks/store/slices/messages.ts`

This task covers `resolveMessageUiPart` (idempotency-on-answeredAt + touched-flag) and `updateMessageGeneratedImageUrl` (inner changed-flag).

- [ ] **Step 1: Rewrite `resolveMessageUiPart`**

Find the existing mutator (lines 439-466) and replace with:

```ts
resolveMessageUiPart: (messageId, partId, answer) =>
  set((state) =>
    updateMessage(state, messageId, (m) => {
      const existing = m.uiParts ?? []
      if (existing.length === 0) return m
      let touched = false
      const next = existing.map((p) => {
        if (p.id !== partId) return p
        if (p.answeredAt) return p
        touched = true
        return {
          ...p,
          answeredAt: new Date().toISOString(),
          answer,
        }
      })
      if (!touched) return m
      return { ...m, uiParts: next }
    }),
  ),
```

- [ ] **Step 2: Rewrite `updateMessageGeneratedImageUrl`**

Find the existing mutator (lines 467-487) and replace with:

```ts
updateMessageGeneratedImageUrl: (messageId, imageId, url) =>
  set((state) =>
    updateMessage(state, messageId, (m) => {
      const images = m.generatedImages
      if (!images) return m
      let changed = false
      const next = images.map((img) => {
        if (img.id !== imageId || img.url === url) return img
        changed = true
        return { ...img, url }
      })
      return changed ? { ...m, generatedImages: next } : m
    }),
  ),
```

- [ ] **Step 3: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store/slices/messages.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(messages-slice): rewrite resolveMessageUiPart + updateMessageGeneratedImageUrl

Both keep their inner idempotency / changed-flag semantics. The outer
'find owning conv' scan moves into the helper.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Rewrite `deleteMessage` (with cascade)

**Files:**
- Modify: `lib/client/hooks/store/slices/messages.ts`

This task covers `deleteMessage`, which removes the message AND cascades to notes/artifacts. Uses `removeMessage` for the messages-side.

- [ ] **Step 1: Add the `removeMessage` import**

The import was added in Task 3 for `updateMessage`. Add `removeMessage`:

```ts
import { removeMessage, updateMessage } from "../store-helpers"
```

- [ ] **Step 2: Rewrite `deleteMessage`**

Find the existing mutator (lines 147-173) and replace with:

```ts
deleteMessage: (messageId) =>
  set((state) => ({
    ...removeMessage(state, messageId),
    notes: state.notes.map((n) =>
      n.messageId === messageId ? { ...n, messageId: null } : n,
    ),
    artifacts: state.artifacts.map((a) =>
      a.messageId === messageId ? { ...a, messageId: null } : a,
    ),
  })),
```

- [ ] **Step 3: Run `bun run check` + tests**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check && cd /Users/blackmount8/_repository/hummingbird && bun run test`
Expected: PASS. The notes/artifacts cascade logic is unchanged; only the messages-side moves through `removeMessage`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store/slices/messages.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(messages-slice): rewrite deleteMessage via removeMessage

Notes/artifacts cascade stays inline (cross-entity side effect, not
message-shape). The messages-side now flows through removeMessage,
mirroring the other 16 mutators.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Final verification

**Files:** none modified.

- [ ] **Step 1: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS. 0 errors. Pre-existing lint warnings unchanged.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test`
Expected: PASS. Test count grew by ~9 (5 updateMessage + 4 removeMessage) net of 0 changes elsewhere.

- [ ] **Step 3: Verify persisted shape unchanged**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/hooks/store/persist.test.ts`
Expected: PASS — the persisted key set test still pins the same set. `STORE_VERSION` unchanged.

- [ ] **Step 4: Confirm net line count**

Run: `cd /Users/blackmount8/_repository/hummingbird && git diff main...HEAD -- lib/client/hooks/store/slices/messages.ts | wc -l`
Expected: large net-deletion diff (the slice shrinks from 519 → ~270 lines).

---

## Self-Review Checklist

- **Spec coverage:** All 4 sections map to tasks. Helper + tests → Tasks 1-2. Simple mutators → Task 3. Sub-array appenders → Task 4. Perf-marker mutators → Task 5. Remaining two → Task 6. `deleteMessage` cascade → Task 7. Final verification → Task 8.
- **Placeholders:** None. Every code block is complete.
- **Type consistency:** `updateMessage<S extends { conversations: Conversation[] }>` and `removeMessage<S extends { conversations: Conversation[] }>` are introduced in Tasks 1-2 and used identically across Tasks 3-7.
- **Out-of-scope respected:** `addMessage`, `truncateMessagesAfter`, `compressMessages`, `uncompressRecap`, `clearMessages` are untouched (different shapes — per-conversation, not per-message). The persistence contract is unchanged.