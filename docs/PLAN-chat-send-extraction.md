# Plan: Chat send-pipeline extraction

Status: **📐 Planned.** No code yet. Spun out of
[`PLAN-code-cleanup.md`](PLAN-code-cleanup.md) Phase 5, which shipped
the low-risk piece (`autoArchiveCodeBlocks` → its own module) and
explicitly deferred the full send-pipeline extraction to its own
focused PR.

Pull the ~620-line `callChatAPI` out of
`components/panels/chat.tsx` into a dedicated hook + a set of pure
helpers, so the chat panel becomes mostly a render layer. **No
behaviour change** — same request shapes, same streaming protocol,
same error/abort handling.

## Why

`components/panels/chat.tsx` is ~1,846 lines. The heart of it is one
`useCallback`, `callChatAPI` (≈ lines 453–1072, **~620 lines**, ~24
dependencies), that runs on every Send. It currently does, inline:

1. Resolve model / workspace system prompt / effective skills cascade.
2. Collect attachments — workspace files (`selectedFileIds`),
   conversation-private files, image data-URLs (vision), MCP servers
   (local-mode creds from `localStorage`), and the message-attachment
   snapshot.
3. Build the transmitted message history (drops `compressed` messages;
   attaches images only to the last user turn).
4. Branch: **task mode** → hand off to `useTaskRunContext().startTask`
   and return; otherwise the inline stream.
5. Open an `AbortController` (tracked per-conversation in a ref map),
   mark typing + streaming, author a placeholder assistant message.
6. Consume the SSE stream, routing each frame to the right store
   mutator: text → `appendToMessage`, reasoning →
   `appendToMessageReasoning` (+ duration), tool calls →
   `setMessageToolCalls` / `liveToolCalls`, images →
   `appendMessageGeneratedImages`, suggestions →
   `setMessageSuggestions`.
7. On settle: clear typing/streaming, auto-archive code blocks, clear
   the controller slot.
8. Error handling: categorised `MessageError`, the mock fallback when
   no `AI_GATEWAY_API_KEY`.

| Pain | Detail |
|---|---|
| Readability | "Where's the image-attachment logic?" → somewhere in 620 lines. |
| Testability | None of it is unit-testable without rendering the panel + mocking React state. |
| Reuse | Project-mode Phase 4's "Run as task" already had to lean on the shared `resolveEnabledSkills` helper because the rest of this pipeline wasn't extractable. The attachment + message build are still trapped here. |
| Fragile deps | The ~24-entry dependency array is exactly where cleanup Phase 1 found two missing deps (`appendMessageGeneratedImages`, `createArtifact`). |

`resolveEnabledSkills` (skills cascade) and `autoArchiveCodeBlocks`
already came out in earlier work — this plan finishes the job.

## Goal & scope cuts

**This ships:**

- A `useChatSend` hook (`lib/client/hooks/use-chat-send.ts`) exposing
  one `send(history, options)` function with the same signature
  `callChatAPI` has today (`{ modelOverride, forcedSkillIds, isRetry,
  asTask }`).
- Pure, tested helpers for the parts that don't need React:
  - `buildAttachments(...)` → the file/image/MCP context for a turn.
  - `buildTransmittedMessages(...)` → the history → API-payload mapping
    (compressed-drop + last-user-image attach).
- `chat.tsx` reduced to a render layer that calls `useChatSend` (target:
  **under ~1,100 lines**, from ~1,846).

**Out of scope (deliberately):**

- The streaming **wire protocol** (pinned in `docs/API.md`) — unchanged.
- Request/response **shapes** (`lib/shared/api-schemas.ts`) — unchanged.
- The task-mode handoff contract (`useTaskRunContext`) — unchanged.
- Any UX / visual change.
- The other chat sub-panels (`chat-message.tsx`, `chat-header.tsx`).
- Smart-paste and drag-and-drop ingestion — *optional* stretch (see
  Phase 4); only if they fall out cleanly.

## The hard constraints (why this is risk-rated higher)

1. **Streaming correctness.** The SSE frame parsing + per-frame routing
   has subtle ordering (placeholder created before first chunk;
   reasoning duration measured first-to-last chunk; tool-call pills
   vs. final `toolCalls`). An extraction can introduce off-by-one or
   races that only surface under specific stream timing.

2. **Per-conversation abort + "stream lands in the right tab."** Today
   `abortControllersRef` is a `Map<convId, AbortController>` and every
   "is this conv streaming?" decision uses the captured `targetConvId`,
   not the live active id — so switching tabs mid-stream doesn't move
   the stream's UI onto the wrong chat. The hook must preserve this
   exactly (the ref map lives in the hook).

3. **Fresh reads vs. closure.** `callChatAPI` deliberately reads
   `chatModel` and MCP servers via `useStore.getState()` (not closure)
   so retry-after-model-change uses the new value. And the panel holds
   a `callChatAPIRef` so other handlers call the latest version. The
   hook has to keep both behaviours.

4. **~24 dependencies migrate.** Each store mutator + derived value the
   pipeline uses must land on the hook (read via `useStore` inside, or
   passed in). Miss one → silent feature breakage. This is the
   error-class cleanup Phase 1 already caught once here.

5. **Highest-traffic surface in the app.** Every send goes through this.
   Regressions are immediately user-visible → needs an interactive
   verification pass, not just unit tests.

## Architecture

```
lib/client/
  hooks/
    use-chat-send.ts        // the hook: owns the abort-controller map,
                            //   the stream consume loop, the task-mode
                            //   branch; returns `send(history, opts)`
  chat/
    auto-archive-code-blocks.ts   // (already shipped)
    build-attachments.ts          // pure: (workspace, conv, files,
                                  //   conversationFiles) → { fileIds,
                                  //   images, mcpServers, … }
    build-messages.ts             // pure: (history, images) → API msgs
                                  //   (drop compressed; image on last
                                  //   user turn only)
    stream-consume.ts             // (optional) the SSE frame→mutator
                                  //   router, if it extracts cleanly
                                  //   behind a small callback set
components/panels/
  chat.tsx                  // render layer: input, message list,
                            //   toolbar; calls useChatSend()
```

`useChatSend` shape:

```ts
export function useChatSend(): {
  send: (history: Message[], options?: {
    modelOverride?: string
    forcedSkillIds?: SkillId[]
    isRetry?: boolean
    asTask?: boolean
  }) => Promise<void>
  /** Stop the active conversation's stream (today's handleStop). */
  stop: () => void
  /** True iff a given conversation id is mid-stream (today via store). */
}
```

Internally it reads the mutators it needs via `useStore` selectors (so
the panel no longer has to thread them), owns `abortControllersRef`,
and calls the pure builders + the task handoff.

## Phases

One PR, staged internally so each step is green before the next:

### Phase 1 — Extract the pure builders (lowest risk)
- `buildTransmittedMessages` — history → payload (compressed-drop,
  last-user image attach). Pure; **unit-tested**.
- `buildAttachments` — workspace + conversation file/image/MCP
  collection. Pure (takes the store slices as args); **unit-tested**.
- Wire `callChatAPI` to call them in place. No structural change to the
  panel yet — just delegating. Verify tests + dev smoke.

### Phase 2 — Move the pipeline into `useChatSend`
- Create the hook; move `callChatAPI`'s body + the
  `abortControllersRef` map + `handleStop` into it.
- The hook reads its mutators via `useStore` internally; the panel
  drops ~24 deps and just calls `send` / `stop`.
- Preserve: per-conv abort map, `getState()` fresh reads, the
  `callChatAPIRef` latest-version behaviour (now internal to the hook).

### Phase 3 — Slim the panel
- `chat.tsx` keeps only render + local input state + the handlers that
  call `send`/`stop` (edit, regenerate, retry, fork, suggestion,
  model-pick, fallback).
- Target under ~1,100 lines.

### Phase 4 — Optional stretch (only if clean)
- Extract smart-paste detection (`use-smart-paste`) and drag-and-drop
  file ingestion (`use-chat-dropzone`). Drop from scope if they tangle.

## Verification

1. `bun run check` clean (typecheck + lint, 0 warnings).
2. `bun test` green; new unit tests for `buildAttachments` +
   `buildTransmittedMessages` (and `stream-consume` if extracted).
3. Dev-server compile smoke (`/dashboard` 200).
4. **Interactive pass (the real gate — needs `AI_GATEWAY_API_KEY`):**
   - Plain send; multi-turn.
   - Send with a workspace file + a conversation-private file attached.
   - Send an image to a vision model.
   - Slash-command forced skill (e.g. `/search`).
   - Muted skill chip (× for one turn).
   - **Stop** mid-stream → placeholder dropped, no orphan.
   - **Regenerate** / **edit-and-resend** / **retry** after an error.
   - Switch conversation tab mid-stream → answer still lands in the
     originating tab.
   - **Run as task** mode → hands off to the Tasks panel.
   - Mock fallback path (unset the key) → labelled mock reply.
   - Reasoning model → "Thought for X.Xs" badge + collapsible.
   - A long code answer → auto-archived artifact appears.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Streaming race / ordering regression | Extract pure builders first (no async); move the consume loop verbatim; full interactive stream checklist. |
| Wrong-tab stream after extraction | Keep the per-conv `abortControllersRef` map + captured `targetConvId` semantics inside the hook; explicit test in the checklist. |
| Missed dependency → silent break | Hook reads mutators via `useStore` internally (fewer hand-maintained deps); typecheck + interactive pass. |
| Task-mode branch broken | Preserve the early-return handoff exactly; checklist item. |

## Out of scope

- Wire protocol / request-response schema changes.
- UX or visual changes.
- `chat-message.tsx` / `chat-header.tsx`.
- The `/api/chat/route.ts` server side (a separate candidate — its own
  prep/dispatch/response-build extraction, noted in
  `PLAN-code-cleanup.md`).
