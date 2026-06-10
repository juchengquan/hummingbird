# Plan: Generative UI parts — typed interactive components from the stream

Status: **🪜 phased — commits 1 + 2 + 3a shipped; 3b deferred to
agent-py / agent-ts ports.**
- ✅ Commit 1 — `info-table` round-trip end-to-end
  ([#179](https://github.com/juchengquan/hummingbird/pull/179),
  2026-06-10). Shared schemas + `renderUI` server tool + SSE emit
  + `Message.uiParts` store mutator + `data-ui` translator + client
  registry + `InfoTable` renderer + chat-message render slot.
- ✅ Commit 2 — interactive kinds + chat-turn resolution
  ([#181](https://github.com/juchengquan/hummingbird/pull/181),
  2026-06-10). `choice` / `confirm` / `mini-form` + `resolveMessage
  UiPart` + `formatAnswerForChat` + `defaultResolutionFor` (auto-send
  for choice/confirm; composer prefill for mini-form) +
  `ChoiceCard` / `ConfirmCard` / `MiniFormCard`.
- ✅ Commit 3a — **task-mode wire contract** (this PR). Extends
  `RequestKind` / `ApprovalEvent` / `PendingInput` /
  `RespondRequestSchema` with the `"ui-part"` request kind +
  `uiKind` / `uiProps` / `uiAnswer` payloads. New
  `makeRenderUITaskTool()` (no `execute`) parallel to
  `makeAskUserTool()`. `task-strip.tsx` renders the shared
  `lib/client/chat/generative-ui/registry.ts` cards when
  `pendingInput.kind === "ui-part"` — same components as chat mode.
  Pure `respondBodyForUiAnswer(requestId, part, answer)` helper +
  `requestKindFor("renderUI", ...) → "ui-part"`. Back-compat: the
  helper also populates the existing `selection` / `value` fields
  so a runner that hasn't learned `ui-part` natively can still
  consume the response via the existing `askUser` path.
- 📐 Commit 3b — **agent-py / agent-ts port** (follow-up; out of
  this PR's scope). The task runners on the dedicated services
  haven't ported `askUser` yet either; the renderUI task tool needs
  to land alongside in the same port PR. Once it does, the runner
  emits `requestKind: "ui-part"` on the `renderUI` tool call (no
  client change) and injects `formatAnswerForChat(...)` as the
  tool's result on continuation. This PR's contract is the target
  the port writes to.

Scope: **M** (~300–450 LOC for a starter kind-set + the registry,
one PR). Origin: the 2026 Generative-UI wave — see [Sources](#sources).

## Why

The AI SDK v5 wire format Hummingbird adopted (useChat B.1–B.3) already
carries `data-*` parts; `translateFrame`
(`lib/client/chat/sse-frame-translator.ts`) maps them to a fixed set of
surfaces today — `data-tool-image` → the gallery, `data-suggestions` →
follow-up chips, reasoning → the reasoning block.

Generative UI is the next layer: the assistant emits a typed `data-ui`
part (a choice card, a confirm dialog, a small form, an info table) and
the client renders a **real interactive React component** instead of a
markdown paragraph. Two reasons it fits Hummingbird specifically:

- **It's the chat-turn twin of `askUser`.** The task path already
  renders rich cards (`ChoiceCard` / `InputCard` in
  `components/agent/task-strip.tsx`) when a long-running task calls
  `askUser`. Plain chat turns have no equivalent — the model can only
  ask in prose and parse the freeform reply. `data-ui` gives ordinary
  chat the same structured-interaction affordance.
- **It's the in-process twin of MCP Apps.** MCP Apps (sibling plan)
  renders *untrusted server HTML* in a sandboxed iframe. Generative UI
  renders *trusted, allow-listed* React components in-process. Same
  goal — interactive affordances in the conversation — different trust
  model. The two ship as a pair and the docs say when to reach for
  which.

## Non-goals — what this is NOT

- **Not arbitrary model-authored code.** The model picks a *kind* from
  an allow-list and supplies *props*; it never ships executable code.
  Arbitrary code is what the MCP Apps iframe + live-artifacts are for.
- **Not a forms/builder framework.** A small, curated kind-set
  (choice, confirm, info-table, mini-form). New kinds are added in code
  with a Zod props schema, not authored at runtime.
- **Not a new bidirectional protocol.** Interactions resolve through
  mechanisms that already exist (a follow-up user turn, or — in
  task mode — the existing `respond` channel). No new socket, no new
  suspend mechanism on the chat path.

## Decisions to pin before code

1. **How the model emits a part.** Via a server tool, **not** raw-text
   parsing. A new `renderUI` `ServerSkill`/tool (`lib/server/skills/`)
   whose `execute` validates `{ kind, props }` against the per-kind Zod
   schema and the route emits a `data-ui` part. Structured tool I/O is
   far more reliable than scraping fenced blocks out of prose.
2. **The kind allow-list (v1).**
   - `choice` — a prompt + N labelled options (single or multi-select)
     + a submit button.
   - `confirm` — a prompt + confirm/cancel.
   - `info-table` — a read-only key/value or columnar table (no
     interaction; the "structured output" case).
   - `mini-form` — 1–4 short labelled text/number/select fields +
     submit.
   Each kind has a Zod `propsSchema`; unknown kind or invalid props →
   the part is dropped + a debug log (never throws in render).
3. **What an interaction does (the resolution model).**
   - **Plain chat (default):** the component's submit composes a
     follow-up **user turn** with the selection/values (e.g. picking
     "Option B" sends "Option B" as the next message), reusing the
     existing send pipeline (`useChatSend`). Optionally *prefill the
     composer* instead of auto-sending (per-kind flag) so the user can
     edit before sending.
   - **Task mode:** if the part was emitted inside a running task, the
     submit routes through the existing `POST /api/tasks/:id/respond`
     channel exactly like `askUser` does — so a task can render a rich
     card without the separate `askUser` plumbing.
4. **Trust + sanitisation.** Components are first-party React; props
   are strings/numbers/enums validated by Zod. No `dangerouslySetInner
   HTML`, no URLs auto-followed, no markdown execution. The allow-list
   *is* the security boundary.
5. **Persistence.** A rendered `data-ui` part persists on the message
   (`Message.uiParts?`) so it survives reload, but becomes **inert
   after it's been answered** (the answer is now a real user turn /
   task response). Inert parts render in a resolved state.

## Shape — code surface

### Server — the `renderUI` tool

`lib/server/skills/render-ui.ts` — a `ServerSkill` (id `"renderUI"`,
toolName `"renderUI"`). `buildTool` returns a tool whose `inputSchema`
is `z.object({ kind: KindEnum, props: z.unknown() })`; `execute`
validates `props` against the kind's schema (shared with the client via
`lib/shared/generative-ui/schemas.ts`) and returns the validated part.
`promptFragment` tells the model when to prefer a UI part over prose.
Registered in `SERVER_SKILLS`.

`app/api/chat/route.ts` — after `renderUI` returns, emit
`emitter.uiPart({ id, kind, props })` (`data-ui`), beside
`emitter.toolImage` / `emitter.codeResult`.

### Shared — schemas (isomorphic)

`lib/shared/generative-ui/schemas.ts` — the single source of truth for
each kind's props (server validates on emit, client validates on
render). Pure Zod, no I/O — lives in `lib/shared/` per the fence rules.

### Wire — translator + store

- `lib/client/chat/sse-frame-translator.ts` — `"data-ui"` →
  `{ type: "ui_part", id, kind, props }`; `NormalisedFrame` extended.
- `lib/client/hooks/store/slices/messages.ts` —
  `appendMessageUiPart(messageId, part)` + `resolveMessageUiPart(message
  Id, partId, answer)` (marks inert) → `Message.uiParts?` (additive;
  migration + `STORE_VERSION` bump per the persist contract).

### Client — the registry + components

`lib/client/chat/generative-ui/registry.ts`:

```ts
export interface UiKindDef<P> {
  schema: z.ZodType<P>
  Component: React.ComponentType<{ part: UiPart<P>; onSubmit: (answer: UiAnswer) => void; inert: boolean }>
}
export const UI_KINDS: Record<UiKind, UiKindDef<unknown>> = {
  choice: { schema: ChoicePropsSchema, Component: ChoiceCard },
  confirm: { schema: ConfirmPropsSchema, Component: ConfirmCard },
  "info-table": { schema: InfoTablePropsSchema, Component: InfoTable },
  "mini-form": { schema: MiniFormPropsSchema, Component: MiniForm },
}
```

Components live in `components/chat/generative-ui/`. Several can reuse
the task-strip card internals (`ChoiceCard` / `InputCard`) — extract the
presentational core so chat + task share it.

`components/panels/chat-message.tsx` — render each `message.uiParts`
entry by looking up `UI_KINDS[kind]`, validating props, and wiring
`onSubmit` to either the chat-send pipeline (plain chat) or the task
`respond` channel (task mode), then `resolveMessageUiPart`.

## Sequencing — one PR, three commits

1. **Commit 1 — shared schemas + the registry + render (no
   interaction).** `info-table` only (the read-only case): server tool,
   `data-ui` part, translator, store, render. Proves the round-trip
   with zero interaction-model risk.
2. **Commit 2 — interactive kinds + chat-turn resolution.** `choice` /
   `confirm` / `mini-form`; submit → follow-up user turn (or composer
   prefill); `resolveMessageUiPart` + inert rendering on reload.
3. **Commit 3 — task-mode resolution.** When the part is emitted inside
   a running task, route submit through `POST /api/tasks/:id/respond`;
   share the presentational card core with `task-strip.tsx`.

## Tests

- **Per-kind schema validation (commit 1)** — valid props pass; invalid
  props are rejected by both the server tool and the client registry
  (the same Zod schema). ~2 cases per kind.
- **`translateFrame` (commit 1)** — `data-ui` → `ui_part`; malformed →
  `null`.
- **Resolution mapping (commit 2)** — a pure helper turning a
  `choice` answer into the follow-up user-message text / task respond
  body; multi-select join; cancel path.
- **Manual smoke (PR checklist)** — model offers a `choice`, clicking an
  option sends the expected user turn; reload shows the part inert with
  the chosen option marked; an `info-table` renders read-only; a task
  emitting a `choice` resolves through `respond`.

## Open questions before commit 1

1. **Auto-send vs composer-prefill default.** Auto-send is sleeker;
   prefill is safer (user edits before committing). **Default:
   per-kind — `confirm`/`choice` auto-send, `mini-form` prefills (forms
   usually want a review).**
2. **Does the model over-reach for UI?** A model that renders a card
   for every reply is annoying. **Default: a conservative
   `promptFragment` ("only when a structured choice or short input
   genuinely helps") + a per-conversation off switch.**
3. **Kind extensibility for MCP/skills.** Should MCP servers or imported
   skills be able to register new kinds? **Default: no in v1 — the
   allow-list stays first-party; untrusted UI goes through MCP Apps'
   iframe instead.**

## Reopen / future work

- **More kinds** (date picker, rating, file picker) as demand shows.
- **Streaming props** — render a card skeleton before all props arrive.
  Defer; v1 emits the part whole.
- **MCP Apps convergence doc** — once both this and `PLAN-mcp-apps.md`
  ship, write the "trusted in-process kind vs untrusted server HTML"
  decision guide.

## Sources

- [The Complete Guide to Generative UI Frameworks in 2026](https://medium.com/@akshaychame2/the-complete-guide-to-generative-ui-frameworks-in-2026-fde71c4fa8cc)
- AI SDK v5 UI message stream (`data-*` parts) — the wire format
  already adopted in [`_done/PLAN-useChat-adoption.md`](_done/PLAN-useChat-adoption.md)
