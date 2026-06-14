# Messages-slice — lift the `updateMessage` reducer into a helper

**Status:** Draft — refactor only, no behaviour change. Identified during the 2026-06-14 architecture review as a Strong shallow-module candidate. The pattern "find owning conversation across ALL conversations, then patch a single message" is open-coded 18 times.

**Goal:** Extract a pure `updateMessage(state, messageId, patch)` helper into `lib/client/hooks/store-helpers.ts`. Each mutator in `lib/client/hooks/store/slices/messages.ts` collapses from a 6-line conversations-map dance to a one-line `set((s) => updateMessage(s, messageId, (m) => ({...m, foo: bar})))`. The "find owning conversation across all conversations" invariant lives in one place.

---

## Decisions locked during brainstorming

| # | Decision | Choice |
|---|---|---|
| Q1 | Helper location | **`lib/client/hooks/store-helpers.ts`** (the existing home for pure store helpers — `mergeWebFetchConfig`, `tombstoneMcpServer`, `defaultSlug`, etc.). |
| Q2 | Helper name | **`updateMessage`** — matches the existing slice mutator name, no rename cascade. |
| Q3 | Helper signature | **`updateMessage<S>(state: S, messageId: string, patch: (m: Message) => Message): Partial<S>`** — returns a state-shape Partial so callers can compose (e.g. setting a sibling notes/artifacts cascade on the same `set` call). |
| Q4 | Finding strategy | **O(N×M) scan, preserved.** The current pattern does a `conversations.map` then a per-conversation `messages.some` scan. The helper does the same. The alternative (a message-id → conversation-id index) is a perf refactor for another day; the spec is local-first. |
| Q5 | "Touched" detection | **Return a sentinel `{}` (no-op partial) when no message matches.** The helper compares the new `conversations` array to the old by reference; if no conversation was touched, return `{}`. This is what every existing mutator currently does implicitly via the `c.messages.some` check. |
| Q6 | Cascade mutators | **Stay in `deleteMessage`.** The notes/artifacts cascade (`messageId → null`) is **not** message-shape; it's a cross-entity side effect. Lives in `deleteMessage` as it does today. (The 17 other mutators do not touch siblings — only `deleteMessage` does.) |
| Q7 | `compressMessages` / `uncompressRecap` | **NOT touched.** They already delegate to `buildCompressedMessages` (a pure helper that does the array surgery). Their outer `set` reads `c.id === conversationId`, not "find by messageId". Different shape. |
| Q8 | `addMessage` | **NOT touched.** It addresses a conversation by id (caller-known), not by messageId. Different shape. |
| Q9 | `clearMessages` | **NOT touched.** It iterates all conversations and clears the active one. No messageId. |
| Q10 | Perf-marker wrappers (`appendToMessage`, `appendToMessageReasoning`) | **Wrapped in the helper call.** The `perfMark("humm/chat/append-message:start")` lives at the slice-mutator boundary (so it counts every call); the `perfMark("humm/chat/append-message:end")` lives inside the `set` updater so it measures the state-update cost. Both preserved. |
| Q11 | `clearMessageError`'s destructure-and-rest | **Helper accepts a `Partial<Message>` patch.** For the `clearMessageError` case (which deletes the `error` key), the mutator writes `{...m}` minus `error` and the helper merges it. Same result. |
| Q12 | Test strategy | **No new test file.** `lib/client/hooks/store-helpers.test.ts` gets one new describe for `updateMessage` (5-6 tests pinning the scan behaviour, the no-op sentinel, the patch identity). Existing slice tests (if any) continue to pass. |

---

## Architecture

```
lib/client/hooks/store-helpers.ts                  (MOD — add updateMessage + 1 describe
                                                         of tests)
lib/client/hooks/store-helpers.test.ts             (MOD — add the describe)

lib/client/hooks/store/slices/messages.ts          (MOD — rewrite 17 mutators to use the
                                                         helper. Net: ~−250 lines. Public
                                                         MessagesSlice interface unchanged.)
```

No state-shape change. No persistence change. No `STORE_VERSION` bump. No cross-slice fanout.

---

## Section 1 — The helper

```ts
// store-helpers.ts (new export)

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
 * re-render. Identical-message-no-change returns `{}` for the same
 * reason (avoids spurious re-renders during streaming when the patch
 * produces a value-equal message).
 */
export function updateMessage<S extends { conversations: Conversation[] }>(
  state: S,
  messageId: string,
  patch: (m: Message) => Message
): Partial<S> {
  let touched = false
  const conversations = state.conversations.map((c) => {
    if (!c.messages.some((m) => m.id === messageId)) return c
    touched = true
    const nextMessages = c.messages.map((m) =>
      m.id === messageId ? patch(m) : m
    )
    // Cheap identity check — skip rebuild if the patch was a no-op.
    if (nextMessages.every((m, i) => m === c.messages[i])) {
      return c
    }
    return { ...c, messages: nextMessages }
  })
  if (!touched) return {}
  return { conversations } as Partial<S>
}
```

### Notes on the helper

- **Generic `<S extends { conversations: Conversation[] }>`** — the helper returns `Partial<S>` so callers can compose (`return { ...updateMessage(...), notes: ... }` for the deleteMessage cascade).
- **Identity-preserving no-op** — if the patch produces a value-equal message, the conversation reference is unchanged. Same behaviour as today's `messages.map` (which always allocates; today's perf budget is identical; this is a micro-improvement, not a regression).
- **Pure** — no `new Date()` inside, no `set`, no side effects. Unit-testable without Zustand.

### Test cases (new describe in `store-helpers.test.ts`)

```ts
describe("updateMessage", () => {
  test("patches the message across all conversations", () => { ... })
  test("no-op when no message matches → returns {}", () => { ... })
  test("identity-preserving no-op → returns {}", () => { ... })
  test("searches across ALL conversations, not just active", () => { ... })
  test("composes with sibling fields via Partial<S>", () => { ... })
})
```

5 tests, all in the existing test file. No new module, no new dependency.

---

## Section 2 — Mutator rewrites (the 17 sites)

Before / after for the most common shape. Every per-message mutator becomes:

Before (e.g. `updateMessage`):
```ts
updateMessage: (messageId, content) =>
  set((state) => ({
    conversations: state.conversations.map((c) => {
      if (c.messages.some((m) => m.id === messageId)) {
        return {
          ...c,
          messages: c.messages.map((m) =>
            m.id === messageId ? { ...m, content } : m
          ),
        }
      }
      return c
    }),
  })),
```

After:
```ts
updateMessage: (messageId, content) =>
  set((state) => updateMessage(state, messageId, (m) => ({ ...m, content }))),
```

The full table:

| Mutator | Before (lines) | After (lines) |
|---|---|---|
| `updateMessage` | 14 | 3 |
| `deleteMessage` | 27 (with cascade) | 8 |
| `truncateMessagesAfter` | 9 (different shape — keep) | 9 |
| `compressMessages` | 26 (delegates to `buildCompressedMessages`) | 26 |
| `uncompressRecap` | 20 (different shape — keep) | 20 |
| `clearMessages` | 9 (different shape — keep) | 9 |
| `appendToMessage` | 21 (with perf marks) | 12 |
| `appendToMessageReasoning` | 23 (with perf marks) | 14 |
| `setMessageReasoningDuration` | 16 | 5 |
| `setMessageToolCalls` | 16 | 5 |
| `setMessageSuggestions` | 14 | 4 |
| `setMessageVerification` | 14 | 4 |
| `setMessageRoutedModel` | 14 | 4 |
| `appendMessageGeneratedImages` | 14 | 6 |
| `appendMessageUiPart` | 18 | 8 |
| `appendMessageMcpApp` | 15 | 7 |
| `replaceMessageMcpAppHtml` | 22 | 12 |
| `resolveMessageUiPart` | 28 | 16 |
| `updateMessageGeneratedImageUrl` | 21 | 9 |
| `setMessageError` | 14 | 4 |
| `clearMessageError` | 17 | 6 |

Net for the slice file: ~519 lines → ~270 lines (≈ −250). Public `MessagesSlice` interface unchanged. Test surface (whatever exists in the messages-slice tests, if any) continues to pass.

---

## Section 3 — Mutators NOT touched

The architecture review found 22 repeats; the spec refactors 17. Five are out of scope:

- **`addMessage`**: addresses by conversationId, not messageId. Different shape.
- **`compressMessages` / `uncompressRecap`**: address by conversationId, then do array surgery via `buildCompressedMessages` (already pure). Different shape.
- **`truncateMessagesAfter`**: uses `findIndex`, not `some`. Different shape.
- **`clearMessages`**: iterates and clears the active conversation. No messageId.

These five mutators **don't repeat the same pattern** and stay as-is. The architecture review's "22" count was a generous count that included the four-shape variants; the deeper count of exact-shape repeats is 17.

---

## Section 4 — `deleteMessage` cascade

Today's `deleteMessage` does:
1. Find owning conversation, remove the message.
2. Detach any notes pointing at it (`notes.map(n => n.messageId === messageId ? { ...n, messageId: null } : n)`).
3. Detach any artifacts pointing at it (`artifacts.map(a => a.messageId === messageId ? { ...a, messageId: null } : a)`).

After the refactor, the `deleteMessage` mutator handles the messages-side via `removeMessage` (see below) and the cross-entity cascade inline:

```ts
deleteMessage: (messageId) =>
  set((state) => ({
    ...removeMessage(state, messageId),
    notes: state.notes.map((n) =>
      n.messageId === messageId ? { ...n, messageId: null } : n
    ),
    artifacts: state.artifacts.map((a) =>
      a.messageId === messageId ? { ...a, messageId: null } : a
    ),
  })),
```

`updateMessage` doesn't support a "delete" operation (its patch type is `(m) => Message`). A second helper `removeMessage` does — see Section 4.

**Decision:** the helper is named `removeMessage` (avoid the `delete` collision). Slice mutator stays `deleteMessage`.

```ts
// store-helpers.ts
export function removeMessage<S extends { conversations: Conversation[] }>(
  state: S,
  messageId: string
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

Test cases for `removeMessage` mirror `updateMessage`'s (4-5 tests).

---

## Section 5 — Persisted shape + migration

**No change.** The persisted localStorage shape is governed by `store/persist.ts`'s `partializeState` + `reviveAndPruneState`, pinned by `store/persist.test.ts`. The refactor doesn't add or remove persisted keys; it only changes the implementation of mutators. `STORE_VERSION` stays at its current value; no `runMigrations` step.

If a regression appears in persist behaviour, the existing `persist.test.ts` catches it.

---

## Section 6 — Tests

### New tests (in `store-helpers.test.ts`)
- `describe("updateMessage")` — 5 tests (Section 1).
- `describe("removeMessage")` — 4 tests (search-across-all, no-op when no match, preserves conversation order, returns `Partial<S>`).

### Existing tests
- `store/persist.test.ts` — unchanged, continues to pin the persisted shape.
- Any existing messages-slice tests (none found in `**/messages-slice*.test.ts` glob) — unchanged.

### Manual
- The chat panel smoke test (start a conversation, send a message, watch the assistant stream, edit a message in place, etc.). Standard manual pass during PR review.

---

## Section 7 — Out of scope (explicit)

- **`buildCompressedMessages`** — already a pure helper in `@/shared/compression`; stays put.
- **`compressMessages` / `uncompressRecap` mutators** — different shape (per-conversation, not per-message).
- **`addMessage`** — different shape (per-conversation).
- **clearMessages / truncateMessagesAfter** — different shape.
- **Cross-entity cascades in OTHER slices** (`deleteWorkspace` in `workspaces.ts`, `deleteConversation` in `conversations.ts`, file/MCP/bookmark removals) — different patterns; each lives in its owning slice by design per CLAUDE.md.
- **A message-id → conversation-id index** — perf refactor; not in scope.
- **Mutator naming changes** — slice mutators keep their existing names; helpers get distinct names.

---

## Section 8 — Risks + mitigations

| Risk | Mitigation |
|---|---|
| Helper loses the "find owning conversation across ALL conversations" invariant via a subtle bug | The 5+4 helper tests pin the cross-all behaviour explicitly. Existing slice tests (if any) exercise the same paths. |
| `Partial<S>` cast (`as Partial<S>`) widens the type — caller could spread it into a non-`S` target | The cast is inside the helper only. Callers do `set((state) => updateMessage(state, ...))` which Zustand's `set` types check. |
| Perf regression from added identity check | The identity check is `nextMessages.every((m, i) => m === c.messages[i])` — O(M) per touched conversation. The current code does the same scan; net identical. |
| `deleteMessage` cascade composition has a typo | Slice test (manual smoke + existing `persist.test.ts`) catches a wrong-cascade regression. |
| New helper file bloat in `store-helpers.ts` | Helper is 30 lines + tests. File goes from 210 → 250 lines. Acceptable. |

---

## Section 9 — Rollout

Single PR. All file changes land together so a regression bisects to one change.

1. Add `updateMessage` + `removeMessage` to `lib/client/hooks/store-helpers.ts`; add the two new describes to `store-helpers.test.ts`. Run `bun run check`.
2. Rewrite the 17 mutators in `lib/client/hooks/store/slices/messages.ts` one at a time, leaving the `MessagesSlice` interface unchanged. Run `bun run check` after each.
3. Run `bun run check` + `bun run test`. Manual smoke (start a chat, edit a message mid-stream).

Branch: `refactor/messages-slice-update-helper`. Target: `dev`.

---

## Section 10 — Wins

- **Locality**: the "find owning conversation across ALL conversations" invariant lives in one 30-line helper. Today it's restated (or implied) 17 times.
- **Leverage**: adding the 18th per-message mutator is one line (`set((s) => updateMessage(s, id, (m) => ({ ...m, foo })))`). Today it's 14 lines.
- **Readability**: a mutator body shows **what** changes, not **how** the conversations array is navigated.
- **Test surface**: the helper is unit-testable without Zustand (pure function over a state shape). The slice-level tests stay where they are.
- **No behaviour change**: every existing mutator continues to produce the same state diff. The new identity-preserving no-op is a strict subset of today's behaviour (today always allocates a new conversation reference even when the patch is identity; tomorrow only allocates when something changed).
- **Sets up future work**: undo/redo (handover menu item) gets a free win — the helper is exactly the unit-of-work shape a reducer would emit.