# Plan: Reasoning-effort control

Status: **✅ shipped** — [#178](https://github.com/juchengquan/hummingbird/pull/178)
on 2026-06-10. Fast / Balanced / Thorough control beside the model
picker; per-model `supportsReasoningEffort` flag in `config/models.json`
gates visibility; chosen tier maps onto provider options via
`reasoningCallOptions` (`@/shared/reasoning-effort`). Plan retained as a
shipped reference. Scope: **S–M** (one PR). Origin: 2026 reasoning-model
depth dials — see [Sources](#sources).

## Why

Reasoning models in 2026 expose a depth control — `reasoning_effort`
(low / medium / high), or an instant↔extended toggle — letting the user
trade latency + cost against answer depth per query. Hummingbird already
*renders* reasoning/thinking tokens in a collapsible block, and already
threads `providerOptions` to the model call (the gateway tagging in #166
proves the plumbing), but gives the user **no control** over how much
the model thinks. Result: extended-thinking latency on trivial turns,
shallow answers on hard ones.

A small per-turn (and per-workspace default) effort control closes that
gap with mostly-existing plumbing.

## Non-goals — what this is NOT

- **Not a new model integration.** Maps onto the *existing* model
  call's provider options.
- **Not relevant to non-reasoning models.** The control is a no-op (and
  hidden) for models without a reasoning budget.
- **Not auto-effort selection.** v1 is an explicit user control; a
  difficulty-based auto-picker is future work.

## Decisions to pin before code

1. **The control surface.** A 3-stop selector (Fast / Balanced /
   Thorough) beside the model picker in the chat input, mapping to
   low / medium / high. Plus a per-workspace default.
2. **Provider mapping.** A pure `lib/shared/reasoning-effort.ts`
   `mapEffortToProviderOptions(modelId, effort)`:
   - Anthropic extended-thinking models → a `thinking` budget
     (token budget per tier);
   - effort-style providers → `reasoning_effort: low|medium|high`;
   - non-reasoning models → `{}` (and the control hides).
3. **Wire field.** `ChatRequestInput.reasoningEffort?: 'low'|'medium'
   |'high'` (default absent = provider default). Threaded to the chat
   route's `streamText` `providerOptions`.
4. **Capability gating.** A `supportsReasoningEffort` flag per model
   entry in `config/models.json` (the registry already carries
   per-model capability flags) drives whether the control shows.
5. **Persistence.** Per-conversation last-used effort + a per-workspace
   default (ui slice / workspace config). No migration if stored in
   existing config; a small migration if it needs a column.

## Shape — code surface

### Shared — the mapper + capability flag

- `lib/shared/reasoning-effort.ts` — the pure mapper + tier→budget
  constants. Single source of truth, server + client.
- `config/models.json` — add `supportsReasoningEffort` (+ optional
  per-tier token budgets) to reasoning-capable entries.

### Wire + route

- `lib/shared/api-schemas.ts` — add `reasoningEffort` to the chat
  request schema.
- `app/api/chat/route.ts` (+ the agent-py / agent-ts chat paths) —
  merge `mapEffortToProviderOptions(model, body.reasoningEffort)` into
  the existing `providerOptions` on the `streamText` call.

### Client — the control

- A `ReasoningEffortPicker` beside the model picker (chat input),
  shown only when the active model `supportsReasoningEffort`. Writes the
  per-conversation value + reads the per-workspace default.

## Sequencing — one PR, two commits

1. **Commit 1 — shared mapper + capability flags + wire.** The pure
   mapper + tests, `config/models.json` flags, the request-schema field,
   route plumbing on all three backends. No UI yet (provider-default
   behaviour unchanged when the field is absent).
2. **Commit 2 — the control + persistence.** The picker, per-conversation
   value, per-workspace default, capability-gated visibility.

## Tests

- **`mapEffortToProviderOptions` (commit 1)** — Anthropic model →
  thinking budget per tier; effort-style provider → `reasoning_effort`;
  non-reasoning model → `{}`. ~6 cases, pure.
- **Schema (commit 1)** — accepts the three values + absent; rejects
  garbage.
- **Capability gating (commit 2)** — control hidden for a non-reasoning
  model; shown for a reasoning one.
- **Manual smoke** — Thorough visibly lengthens thinking on a hard
  prompt; Fast shortens it; switching to a non-reasoning model hides the
  control.

## Open questions before commit 1

1. **Tier → token-budget values for Anthropic thinking.** **Default:
   low ≈ 2k, medium ≈ 8k, high ≈ 24k thinking tokens — tune against the
   model's limits.**
2. **Per-turn vs sticky.** **Default: sticky per conversation (last
   choice persists) + a workspace default; not reset each turn.**
3. **Interaction with the context meter.** Thinking tokens count toward
   the window. **Default: reflect the chosen budget in the meter's
   estimate.**

## Reopen / future work

- **Auto-effort** — a cheap classifier picks the tier from query
  difficulty (pairs with prompt optimisation's classifier work).
- **Per-skill effort** — force high effort for research/agent tasks,
  low for quick chat.

## Sources

- [ChatGPT thinking-duration controls](https://skywork.ai/blog/chatgpt-thinking-duration-controls/)
- [Prompting reasoning models in 2026](https://sureprompts.com/blog/ai-reasoning-models-prompting-complete-guide-2026)
