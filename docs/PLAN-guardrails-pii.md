# Plan: Optional guardrails + PII redaction

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(third research round, 2026-06-09) to **Next**. Scope: **M** — and
mostly relevant once shared/multi-user deployments exist (off by default
for single-user). Origin: 2026 self-hostable guardrail toolkits — see
[Sources](#sources).

## Why

A self-hostable input/output safety layer — PII redaction (mask SSNs,
cards, emails, health identifiers) + content moderation (jailbreak /
injection / unsafe-content screening) — is table-stakes for any shared
or enterprise deployment, and a natural fit for Hummingbird's self-host
posture (NeMo Guardrails / Presidio-class engines run locally). It's
**optional and off by default** so the single-user experience is
untouched, but available as a per-workspace policy when Hummingbird is
deployed for a team.

It also composes cleanly with the MCP-proxy SSRF guard + per-IP budgets
already in place — the same "defensive boundary on the route" spirit,
extended to content.

## Non-goals — what this is NOT

- **Not on by default.** Single-user solo use sees no change. Opt-in
  per workspace.
- **Not a content-policy stance.** Hummingbird ships the *mechanism*
  (pluggable redaction + moderation hooks); the policy/thresholds are
  the deployer's choice.
- **Not a managed cloud dependency.** Self-hostable engine behind an
  adapter; no required SaaS.
- **Not prompt-injection elimination.** Reduces risk via screening;
  doesn't claim to defeat all injection.

## Decisions to pin before code

1. **Hook points.** A pre-hook (before the model call) and a post-hook
   (before returning/streaming to the client) on the chat route + the
   deterministic non-chat routes. Pre = redact PII / screen input;
   post = screen output.
2. **Engine.** Pluggable behind `lib/server/guardrails/`: a default
   self-hostable engine (Presidio for PII, a small moderation
   classifier / NeMo Guardrails for content) reachable over a
   configured base URL (the Minimax/E2B adapter pattern). Absent config
   → hooks are no-ops.
3. **Policy scope.** Per-workspace policy (`enabled`, `redactPii`,
   `moderateInput`, `moderateOutput`, thresholds). Stored in workspace
   config.
4. **Redaction semantics.** Default **mask** (replace with `‹EMAIL›`
   placeholders) rather than block, so the conversation continues;
   blocking is an opt-in stricter mode.
5. **Streaming.** Output moderation on a stream is hard (tokens arrive
   incrementally). v1: moderate the *input* + the *final* assistant
   message (post-stream); a streaming-moderation mode is future work.
6. **Failure mode.** A guardrail-engine outage must **fail safe per
   policy** — default fail-open (log + proceed) for availability, with
   an opt-in fail-closed (block) for strict deployments.

## Shape — code surface

### Engine adapter — `lib/server/guardrails/`

```ts
export interface Guardrail {
  redact(text: string): Promise<{ text: string; entities: PiiEntity[] }>
  moderate(text: string, dir: "input" | "output"): Promise<{ allowed: boolean; categories: string[] }>
}
export function selectGuardrail(): Guardrail | null   // null when unconfigured
```

- A Presidio/NeMo-backed impl reached over `GUARDRAILS_BASE_URL`;
  `null` when no engine is configured (hooks become no-ops).

### Hooks on the routes

- `app/api/chat/route.ts` — before dispatch: redact + (optional) input
  moderation; after the turn settles: output moderation on the final
  message. Per-workspace policy gates each step.
- The deterministic routes (`summarize`, `extract`) get the same
  pre-redaction so PII never reaches the model there either.
- Mirror in `services/agent-py` + `agent-ts` so policy holds on every
  backend.

### Policy + UI

- Per-workspace guardrail policy in workspace config (+ a small
  migration if a column is needed).
- A workspace-settings panel: enable, choose redact/moderate steps,
  thresholds, fail-open/closed.

## Sequencing — PR series

1. **PR 1 — engine adapter + PII redaction (input).** The `Guardrail`
   interface + a Presidio-backed impl + the pre-hook redaction on chat
   + deterministic routes. Off by default; per-workspace enable.
2. **PR 2 — content moderation (input + final output).** Input
   screening + final-message screening; fail-open/closed policy; the
   settings panel.
3. **PR 3 — service-backend parity + streaming moderation.** Python/TS
   twins; explore incremental output moderation on the stream.

## Tests

- **Redaction (PR 1)** — known PII patterns masked; the entity list is
  returned; non-PII text untouched. Against a stub engine.
- **No-op when unconfigured (PR 1)** — no engine → hooks pass through
  (regression guard so default users are unaffected).
- **Policy gating (PR 2)** — each step runs only when its policy flag is
  on; fail-open vs fail-closed on engine error.
- **Manual smoke** — with redaction on, an email in a prompt is masked
  before the model sees it; with moderation on, an unsafe input is
  blocked per policy; with guardrails off (default), nothing changes.

## Open questions before PR 1

1. **Self-host engine choice.** Presidio (PII) + NeMo Guardrails
   (content) vs an all-in-one. **Default: Presidio for PII first
   (focused, mature); content moderation as a separate adapter in
   PR 2.**
2. **Where the engine runs.** Sidecar vs in-process. **Default: sidecar
   over a base URL (clean isolation, matches the runner pattern).**
3. **Redaction reversibility.** Should the user see what was masked?
   **Default: show a small "N items redacted" affordance; never
   re-expose the raw value to the model.**

## Reopen / future work

- **Streaming output moderation** — incremental screening as tokens
  arrive (PR 3 explores; harder).
- **Audit log** — record redaction/moderation events (pairs with the
  parked Langfuse observability).
- **Per-skill policy** — stricter screening for tool outputs (e.g.
  browse / code-interpreter results).

## Sources

- [NVIDIA NeMo Guardrails](https://github.com/NVIDIA-NeMo/Guardrails)
- [Best AI guardrails platforms 2026](https://www.getmaxim.ai/articles/best-ai-guardrails-platforms-in-2026/)
- [LLM guardrails for enterprise AI](https://www.getmaxim.ai/articles/understanding-llm-guardrails-and-how-to-implement-them-for-enterprise-ai/)
