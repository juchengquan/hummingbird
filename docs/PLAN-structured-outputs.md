# Plan: Structured outputs / constrained decoding

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(third research round, 2026-06-09) to **Next**. Scope: **M** (one PR,
incremental per call site). Origin: native structured output went GA
across providers in early 2026 — see [Sources](#sources).

## Why

Hummingbird's deterministic calls coax JSON out of the model with
best-effort parsing: `parseSuggestionsJson` strips ```` ```json ````
fences, tries `JSON.parse`, and falls back to `[]` on any failure. That
works *usually* — and silently degrades when it doesn't (suggestions
vanish, a summary's `keyTopics` come back empty). Native **structured
output** with constrained decoding (a JSON-Schema-masked decoder, GA
across OpenAI / Gemini / Anthropic by early 2026) guarantees
schema-valid output 100% of the time.

The deterministic call sites — follow-up suggestions, `summarize` (all
four modes), `extract` summaries, the editor `comment` / `table` tools,
project-breakdown — all have a known output shape (mostly Zod schemas
already exist in `lib/shared/`). Switching them to structured output
removes a class of silent failures and lets the defensive parsers
become fallbacks.

## Non-goals — what this is NOT

- **Not the chat stream.** Free-form assistant prose stays free-form.
  Only the structured, deterministic calls.
- **Not removing the lenient parsers.** They stay as a fallback for
  models/providers without native structured-output support.
- **Not a schema redesign.** Reuses the existing response shapes; just
  enforces them at generation time.
- **Not constrained decoding we implement.** We use the AI SDK's
  structured-output mode (`generateObject` / schema option); the
  provider does the masking.

## Decisions to pin before code

1. **Mechanism.** The AI SDK's `generateObject` (or `streamObject`)
   with a Zod schema per call site, when the active model declares
   support; else fall through to the current `generateText` +
   lenient-parse path.
2. **Capability gating.** A `supportsStructuredOutput` flag per
   `config/models.json` entry decides per-model which path runs.
3. **Schema source of truth.** The Zod schemas already in
   `lib/shared/` (suggestions, summarize modes, extract, comment/table)
   become the structured-output schemas — one definition, used for both
   generation and validation.
4. **Fallback contract.** On a provider without support, or a
   structured-output error, fall back to the existing
   `generateText` + parser so behaviour never regresses.
5. **Rollout order.** Start with **suggestions** (smallest, highest
   silent-failure rate today), then summarize, then the editor tools.

## Shape — code surface

### Shared — schemas + a helper

- Consolidate the per-call Zod schemas in `lib/shared/` (some exist;
  add the missing ones for summarize modes / extract).
- `lib/server/ai/structured.ts` — `generateStructured(model, schema,
  prompt, fallback)`: uses `generateObject` when
  `supportsStructuredOutput`, else runs `fallback()` (the existing
  text+parse path). One wrapper every call site opts into.

### Call sites

- **Suggestions** — `app/api/chat/route.ts` suggestion call (+ the
  agent-py / agent-ts `generate_chat_suggestions`): emit via
  `generateStructured(SuggestionsSchema, …)`; `parseSuggestionsJson`
  becomes the fallback.
- **Summarize** — `app/api/summarize/route.ts` (+ service twins): per
  mode (`file` → `{summary, keyTopics}`, `conversation` →
  `{summary, keyPoints, decisions}`, etc.).
- **Extract** — the auto-summary in `app/api/extract/route.ts`.
- **Editor comment / table** — `app/api/ai/command/` already emit
  structured comment/table parts; enforce their schemas.

### Capability flag

`config/models.json` gains `supportsStructuredOutput` per entry.

## Sequencing — one PR, three commits

1. **Commit 1 — helper + suggestions.** `generateStructured` +
   capability flag + Zod schema; switch the suggestion call; keep the
   lenient parser as fallback. Measurable: zero empty-suggestion
   failures on supporting models.
2. **Commit 2 — summarize + extract.** Per-mode schemas; switch the
   routes + service twins.
3. **Commit 3 — editor comment/table.** Enforce the existing
   comment/table schemas via structured output.

## Tests

- **`generateStructured` (commit 1)** — supporting model → object path;
  non-supporting → fallback runs; structured error → fallback. Pure
  with a stubbed model.
- **Schemas** — each call's schema accepts a valid sample, rejects a
  malformed one (server + client share the schema).
- **Fallback parity** — the fallback path still produces the same shape
  the consumers expect (regression guard).
- **Manual smoke** — suggestions never come back empty on a supporting
  model; a summarize call returns fully-populated structured fields.

## Open questions before commit 1

1. **Streaming structured output.** Suggestions are post-turn (no
   stream needed); summaries could stream. **Default: non-streamed
   `generateObject` for all v1 call sites; revisit `streamObject` for
   summaries if latency matters.**
2. **Anthropic support specifics.** Anthropic structured output was
   beta Nov 2025 / GA early 2026; confirm the AI SDK exposes it for the
   pinned model versions, else those models use the fallback. **Default:
   gate strictly on the capability flag.**
3. **Schema strictness vs model creativity.** Over-tight schemas can
   degrade quality. **Default: keep schemas as loose as the consumer
   allows (optional fields stay optional).**

## Reopen / future work

- **Pairs with semantic caching** — deterministic structured calls are
  exactly the cache targets.
- **Pairs with prompt optimisation** — schema-validity is a clean,
  free metric for the GEPA loop.
- **Tool-call argument enforcement** — extend constrained decoding to
  MCP / skill tool arguments for more reliable tool use.

## Sources

- [LLM structured output in 2026](https://dev.to/pockit_tools/llm-structured-output-in-2026-stop-parsing-json-with-regex-and-do-it-right-34pk)
- [How structured outputs + constrained decoding work](https://letsdatascience.com/blog/structured-outputs-making-llms-return-reliable-json)
- [Reliable JSON from any LLM (Pydantic + Zod, 2026)](https://techsy.io/en/blog/llm-structured-outputs-guide)
