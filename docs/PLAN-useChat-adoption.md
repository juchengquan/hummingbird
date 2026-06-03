# Plan: `useChat()` adoption in the chat panel

Status: **📋 Draft.** Open follow-up from
[`PLAN-agent-api.md`](./PLAN-agent-api.md) and PR #143's
follow-up note. The chat panel's stream consumer
(`lib/client/hooks/use-chat-send.ts`) still parses our **custom**
SSE shape (`{type:"text"|"reasoning"|"tool_call"|"tool_result"|
"tool_image"|"suggestions"|"error"|"done"}`). The Phase 3g work
on the backend side already emits an **AI SDK v5 UI message
stream** at `?format=ai-sdk` on every chat backend (Next.js
inline, agent-py, agent-ts) — but no client-side consumer reads
it yet.

This plan surveys the migration options and lands on a
recommended sequence. The trade-off is bigger than it looks; the
hand-rolled consumer carries Hummingbird-specific behaviour
(reasoning duration timing, generated-image appending, follow-up
suggestions, per-conversation streaming state) that doesn't map
to `useChat()`'s built-in abstractions out of the box.

## What we have today

`use-chat-send.ts` (`useChatSend()` hook, ~800 LOC):

1. **Receives** the SSE stream via `apiClient.chat.stream()` and
   parses it manually with a `TextDecoderStream`-style loop.
2. **Manages a placeholder message** — `addMessage({ role:
   'assistant', content: '' })` on the first frame of any kind,
   then appended-to incrementally as text-deltas arrive.
3. **Handles 8 frame types**:
   - `text` → `appendToMessage`
   - `reasoning` → `appendToMessageReasoning` + timing
     (`reasoningStart` / `reasoningLast`) → `setMessageReasoningDuration`
     on stream end
   - `tool_call` → local `liveToolCalls` state (returned from
     the hook so the chat panel can render running tool pills)
   - `tool_result` → updates `liveToolCalls` with summary +
     optional `results[]` for the Sources strip
   - `tool_image` → `appendMessageGeneratedImages` with
     persisted Storage URLs
   - `suggestions` → `setMessageSuggestions` (post-message
     follow-up chips)
   - `error` → break out + `surfaceError`
   - `done` → break out cleanly
4. **Conversation typing state** — `setConversationTyping(convId,
   true)` on start, false on stream end. Multi-conversation safe
   (a different chat tab can stream concurrently).
5. **Abort plumbing** — per-conversation `AbortController`s, so
   switching tabs mid-stream doesn't leak. Sending a new message
   in the same tab aborts the previous turn.
6. **Mock fallback** — when `AI_GATEWAY_API_KEY` is unset, the
   hook synthesises a fake response (with mock reasoning) so the
   app stays interactive in dev.
7. **Per-message error surface** — `setMessageError(id, code)`
   with categorised codes (`provider`, `rate_limit`, etc.) so the
   bubble can render a retry affordance.

Backends emit the custom format from:
- `app/api/chat/route.ts` (Next.js inline, the default consumer)
- `services/agent-py/src/agent_py/chat.py` (Python service)
- `services/agent-ts/src/chat.ts` (TS service)

All three also emit AI SDK v5 format at `?format=ai-sdk`.

Editor side, separately: `components/editor/use-chat.ts` already
uses `useChat()` from `@ai-sdk/react`. That's a totally different
pipeline (Plate.js AI commands), not the chat panel.

## What `useChat()` would buy us

| Win | Today | With useChat |
|---|---|---|
| **Streaming, decoding, abort plumbing** | hand-rolled (~80 LOC) | provided by `@ai-sdk/react` |
| **Tool-call / tool-result UI parts** | bespoke `liveToolCalls` state | `message.parts[]` with `tool-input-*` / `tool-output-*` types |
| **Multi-step tool loops** | the hook just consumes whatever frames arrive | `useChat` walks `streamText`'s parts natively |
| **Wire format** | one bespoke format (8 types) + parallel AI SDK format | one AI SDK v5 format |
| **Ecosystem** | none | works with `@platejs/ai`, generic AI SDK observability, etc. |

## What `useChat()` doesn't give us

The features that don't map cleanly:

| Feature | Why it doesn't map |
|---|---|
| **Reasoning-duration timing** | AI SDK has `reasoning` parts but no built-in timer; we'd need to derive it from `onChunk` / part timestamps. |
| **Generated-image persistence + `tool_image` frame** | Our custom shape carries `storagePath` + `prompt` + `mode` per image. AI SDK supports custom `data-*` parts; we'd map `tool_image` → `data-tool-image`. |
| **Follow-up suggestions** | Same — a custom `data-suggestions` part. |
| **Per-conversation streaming state** | `useChat()` is hook-per-chat-id. We have N conversations and arbitrarily many can stream concurrently. Either we instantiate N hooks (heavy) or we keep the existing manual abort + typing state and just borrow the parser. |
| **Mock fallback when `AI_GATEWAY_API_KEY` is unset** | useChat assumes a real endpoint. We'd need a fake transport. |
| **Categorised error codes on the assistant message** | useChat exposes a top-level `error`, not per-message error metadata. Would need a parallel store mutator triggered from `onError`. |

## Three migration paths

### Option A — Full `useChat()` adoption (deep refactor)

Drop `use-chat-send.ts` entirely. Replace with `useChat()`
from `@ai-sdk/react`, configured with `DefaultChatTransport`
pointing at `apiUrls.chat()`. Bind reactivity from
`useChat()`'s `messages` to the existing store via a sync
layer (messages persist locally + optionally sync to Supabase).

**Pros.** Single source of truth for streaming state.
Multi-step tool loops "just work." Aligns with the editor
side. Less code to own.

**Cons.** Major refactor. The hook owns `messages` and we own
them in Zustand; reconciling is non-trivial. Per-conversation
isolation may need N hooks. Mock fallback, suggestions,
generated-image storage paths, reasoning timing, per-message
error codes all need custom adapters. Conservatively two to
three weeks of careful work.

### Option B — Adopt AI SDK SSE format, keep our own state machine

Drop the custom format. Backends emit only AI SDK v5 frames
(some already do via `?format=ai-sdk`). Our consumer parses the
AI SDK frames into the same Zustand state it does today —
`text-delta` → `appendToMessage`, `tool-input-available` →
`liveToolCalls`, `tool-output-available` → `liveToolCalls`
update. Custom-shaped extras (`tool_image`, `suggestions`,
`reasoning` duration) ride on `data-*` parts (AI SDK supports
them natively).

**Pros.** Backends consolidate on one format. Frontend keeps
its Hummingbird-specific state machine. Lower risk than
Option A — no Zustand-vs-useChat reconciliation.

**Cons.** Still hand-rolled parsing on the client. Doesn't
unlock the ecosystem wins (the consumer can't be swapped for
generic AI SDK components later). Custom `data-*` parts on
three backends still need to stay in sync.

### Option C — Don't migrate

Keep the custom format + the hand-rolled consumer. The chat
panel works; the backends already support the AI SDK format
for any future consumer that wants it (e.g. a CLI client).

**Pros.** Zero work. Zero risk.

**Cons.** Our consumer drifts further from the ecosystem each
year. New AI SDK features (e.g. structured outputs, generic
tool UI parts) require parallel implementations.

## Recommendation: **Option B**, staged

Option A is the right end state but the migration cost is
disproportionate to the immediate win — the chat panel works
today, and the underlying architectural debt is the *two-format*
problem, not the *hand-rolled parser* problem.

Option B fixes the two-format problem at lower cost and leaves
the door open to Option A later when the placeholder + tool
state machine matures into something resembling
`message.parts[]` naturally.

### Phased rollout for Option B

Each phase is a separate PR. Each is reversible (toggle a flag /
revert one commit) without forcing a co-deploy across stacks.

#### Phase B.1 — Server: extend AI SDK format with our custom parts

Initial sketch had this as a single ~1-day commit; reality forced
a 4-way split because (a) the three backends aren't symmetric
(the Next.js inline route has no AI-SDK formatter at all today),
(b) reasoning isn't a custom data part — it's a first-class AI
SDK UI part (`reasoning-start` / `reasoning-delta` / `reasoning-end`),
and (c) suggestions don't exist on the service backends yet.

| Sub-phase | Backend | Adds | Status |
|---|---|---|---|
| **B.1a** | agent-ts | reasoning channel (built-in AI SDK part) + format-aware tool_image (`data-tool-image`) | ✅ PR #148 |
| **B.1b** | agent-py | reasoning channel (refactored `_stream_text_deltas` → `_stream_channel_deltas` to walk raw events; `data-tool-image` is N/A — agent-py doesn't emit a `tool_image` frame today and `generateImage` persistence is a separate gap) | ✅ this PR |
| **B.1c** | Next.js inline route | parallel AI-SDK formatter (route is custom-only today) emitting text + tool + reasoning + `data-tool-image` | pending |
| **B.1d** | all three | `data-suggestions` (requires implementing follow-up generation on the service backends; Next.js inline already has it on the custom path) | pending |

Frontend doesn't change in B.1. The AI SDK SSE shape carries
progressively more of what the custom shape does. B.2 can move
on as soon as one backend has full parity — agent-ts after B.1a.

#### Phase B.2 — Frontend: swap consumer parser, keep state machine (~2 days)

Replace the manual SSE parser in `use-chat-send.ts` with the
AI SDK's `readUIMessageStream()` (returns an async iterator of
the same UI message parts). Map parts to the existing Zustand
mutators 1:1:

| AI SDK part | Existing mutator |
|---|---|
| `text-start` / `text-delta` | (start) `ensurePlaceholder()`, then `appendToMessage` |
| `text-end` | (no-op; place keeps its content) |
| `tool-input-available` | `liveToolCalls` push |
| `tool-output-available` | `liveToolCalls` update |
| `data-reasoning` | `appendToMessageReasoning` + timer logic |
| `data-tool-image` | `appendMessageGeneratedImages` |
| `data-suggestions` | `setMessageSuggestions` |
| `error` | `setMessageError` |
| `finish` | mark stream end |

Chat panel UI, message store, placeholder lifecycle — all
unchanged. The mock fallback stays. Per-conversation typing /
abort plumbing stays.

#### Phase B.3 — Server: retire the custom format (~0.5 day)

Once Phase B.2 ships on every supported consumer (we can verify
via deploy notes; this is a single Next.js app + the optional
remote services), strip the custom `chat_stream` /
`chat_stream_with_tools` paths from all three backends.
`chat_stream_ai_sdk` becomes the only path. `?format=` query
param becomes vestigial — keep accepting it for one release,
then drop.

#### Phase B.4 — Frontend: incremental adoption of `useChat()` (optional, defer)

Once we've stayed on the AI SDK format for a release cycle, we
can experiment with replacing the hand-rolled state machine
with `useChat()` in one panel (e.g. a single-conversation
"Quick chat" overlay) to validate the reconciliation pattern
before refactoring the main chat panel.

## Risk + non-goals

**Risks:**
- **Three-backend sync.** Adding custom `data-*` parts means
  each backend must emit them identically. Mitigation: lift
  the part-emitter helpers into a shared place (a doc + a
  conformance test fed off `docs/API.md`).
- **AI SDK protocol upgrades.** The `v1` header buys us
  versioning; breaking changes are explicit. Low risk in
  practice; the AI SDK has been stable on v5 since ~Q1 2026.
- **Mock fallback drift.** Once parsing comes from the AI SDK,
  the mock has to emit AI SDK frames. Small adapter; trivial.

**Explicit non-goals:**
- Adopting `useChat()` literally in the main chat panel
  (deferred to Phase B.4 — optional).
- Frontend `messages` ownership migration (Zustand stays the
  source of truth).
- Tool-call UI redesign. The existing pill / Sources-strip UI
  stays; only the parsing layer changes.

## Estimate

| Phase | Effort | Cumulative |
|---|---|---|
| B.1 (server emit custom data-* parts) | ~1 day | 1 day |
| B.2 (client parser swap) | ~2 days | 3 days |
| B.3 (retire custom format on servers) | ~0.5 day | 3.5 days |
| B.4 (incremental useChat in a single panel) | ~1 week | optional |

So ~3.5 days of focused work for the main migration, with a
clean exit point after each phase. Compare with Option A's two
to three weeks for the full conversion — and with the
zero-risk Option C if we want to defer the whole thing for
another quarter.

## Decision

Default to **Option B, Phase B.1 + B.2** in the next two work
slots. Re-evaluate B.3 and B.4 after.
