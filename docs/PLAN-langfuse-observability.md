# Plan: Langfuse self-hosted observability

Status: **⏸ deferred / low priority** (deprioritised in the 2026-06-09
market refresh — see [MASTER_PLAN § Parked / low priority](MASTER_PLAN.md#parked--low-priority)).
A trace/cost dashboard only earns its keep once eval-writing capacity
is committed (open question #2 in the inspirations plan); the shipped
per-workspace Gateway tagging (#166) covers the cost-visibility 80% in
the meantime. **Re-open when** a model swap / cost regression needs
distributed-trace debugging, or eval capacity is allocated. The plan
below is preserved as-is for when that happens. Item #10 from
`docs/PLAN-cross-product-inspirations.md`. Scope: **M** (multi-day,
one PR for infra + Next.js instrumentation; optional commit for
agent-py / agent-ts; eval surface deferred to a follow-up).

## Why

Today Hummingbird has zero distributed tracing. When a chat turn
misbehaves — a tool call takes 12s, a model returns 0 tokens after
20 steps, a search retrieval misses — the only signal is the SSE
frames the user sees in the panel + whatever `console.warn` lines
the chat route happened to emit. Across three backends
(`app/api/chat/route.ts`, `services/agent-py/...`,
`services/agent-ts/...`), each turn passes through 4–10 separately
observable steps (model call, tool invocations, sub-model calls
for `chooseTool` / suggestions / summarise) and there's no way to
see them as a tree.

Langfuse is the self-host story for closing this gap. One Docker
Compose stack covers:

- **Distributed traces** — every `streamText`/`generateText` call
  becomes a span via the AI SDK's `experimental_telemetry`; tool
  invocations nest under it. Python + TS services emit OTel spans
  for the same shape, all aggregating in one UI.
- **Per-workspace cost visibility** — already-shipped
  `workspace:<id>` tag from PR #166 flows into the OTel attributes
  Langfuse groups by; you'll see "Q4 OKRs workspace burned $4.20
  this week" without writing a single SQL query.
- **A regression net before every Anthropic model swap** — datasets
  + LLM-as-judge evals run on production traces (replay a captured
  turn against a candidate model and grade the output).
- **Prompt management as a side benefit** — Langfuse hosts prompt
  versions with strong client+server caching; you change a prompt
  in their UI without redeploying. Not the headline win for v1.

The cohort survey ranked Langfuse as one of the top three items —
not because it's a feature users see, but because EVERY future
item gets easier with traces (Letta-memory debugging, Beam comparing
model outputs, Aider editor pair measuring planner accuracy).

## Non-goals — what this PR is NOT

- **Not LiteLLM virtual keys / per-workspace dollar budgets.**
  Langfuse's dashboard is read-only; budget enforcement is a
  separate cohort. The `workspace:<id>` tag we already emit makes
  per-workspace cost *visible*; enforcement needs a writable proxy.
- **Not Phoenix-style prompt playground.** Replaying a captured
  trace against alternate prompts/models is a Langfuse EE feature
  (Dataset Runs). The OSS surface only ingests + visualises; the
  playground UI is paid. Visible-trace UI alone is the v1 win.
- **Not RBAC / audit logs / SSO enforcement / SCIM.** All EE-gated.
  Single-tenant self-host (org-level RBAC + basic SSO) is enough
  for Hummingbird's per-user model today.
- **Not Helicone.** Maintenance mode since 2026-03-03 per the
  cohort notes — borrow no code, no dep.
- **Not a build-it-yourself trace UI.** OTel + Langfuse is a known
  contract; rolling a custom UI would be 100x the effort for
  worse fidelity.

## Decisions to pin before code

These need a one-line answer before commit 1; defaults baked in
where the choice is obvious.

1. **Self-host vs hosted.** Langfuse Cloud has a free tier (50k
   observations / month) — good for a dev pilot. Self-host is
   one `docker compose up` away once the dev pilot validates the
   shape. **Default: hosted free tier for the first PR; flip to
   self-host once the data shape is proven.** (`LANGFUSE_HOST`
   already env-driven; switching is a `.env` edit, no code change.)
2. **Where the OTel exporter runs in Next.js.** Two options:
   (a) `@vercel/otel` at the route-handler boundary — auto-traces
   the HTTP request as the root span. (b) `instrumentationHook` in
   `next.config.ts` + manual span scoping. **Default: (a) for
   v1 — turnkey; the trace tree is already correct for
   `/api/chat`.**
3. **Span attribute schema.** Langfuse reads several conventions
   ([Langfuse OTel docs](https://langfuse.com/docs/integrations/opentelemetry)):
   `langfuse.user.id`, `langfuse.session.id`, `langfuse.tags`,
   `gen_ai.system`, `gen_ai.request.model`. **Default: use
   `langfuse.session.id = conversationId`,
   `langfuse.user.id = workspaceId` (workspaces have one owner
   today), and feed the existing `workspace:<id>` / `model:<id>`
   tags into `langfuse.tags`.** The AI SDK auto-emits the
   `gen_ai.*` semantic-convention attributes.
4. **Tracing in agent-py + agent-ts.** Both services already log
   structured events; both can emit OTel spans with one
   instrumentation lib (`opentelemetry-instrumentation-fastapi`
   / `@opentelemetry/instrumentation-http` for Hono). **Default:
   defer the services to commit 2 — Next.js coverage alone is
   the chat-route win; the services follow once Next.js is
   green.**
5. **What we DON'T trace.** No spans for: localStorage reads, sync
   diff/upload (huge volume, low signal), Zustand mutator calls,
   `experimental_telemetry.recordInputs = false` for any turn
   carrying a Supabase JWT (don't leak auth). **Default: as
   listed; revisit if a gap shows up.**

## Shape — what gets wired

### Stack

`docker-compose.yml` (repo root) gains a new `langfuse` service
pointing at the public Docker image; backed by Postgres + ClickHouse
+ Redis containers per
[the official docs](https://langfuse.com/self-hosting/docker-compose).

For the dev pilot (decision pin #1), the compose service is
disabled by default — the `.env` switch is `LANGFUSE_HOST` (their
hosted endpoint) + a Langfuse-issued public/secret key pair. Empty
env → no exporter installed → no traces emitted → zero overhead.

### Next.js instrumentation

New file: `instrumentation.ts` at the repo root (Next.js's
documented entry-point for the `@vercel/otel` package).

```ts
import { registerOTel } from "@vercel/otel"
import { LangfuseExporter } from "langfuse-vercel"

export function register() {
  if (!process.env.LANGFUSE_PUBLIC_KEY) return
  registerOTel({
    serviceName: "hummingbird-next",
    traceExporter: new LangfuseExporter({
      // Env-driven; Langfuse SDK picks up LANGFUSE_PUBLIC_KEY /
      // LANGFUSE_SECRET_KEY / LANGFUSE_HOST automatically.
    }),
  })
}
```

Chat route gains a one-line addition to the `streamText` call:

```ts
streamText({
  // …existing…
  experimental_telemetry: {
    isEnabled: !!process.env.LANGFUSE_PUBLIC_KEY,
    functionId: "chat",
    metadata: {
      "langfuse.session.id": conversationId ?? "anonymous",
      "langfuse.user.id": body.workspaceId ?? "anonymous",
      "langfuse.tags": [
        `workspace:${body.workspaceId ?? "unknown"}`,
        `model:${modelId}`,
      ],
    },
  },
})
```

Same one-line addition replicates to:
- `app/api/summarize/route.ts` (`functionId: "summarize"`)
- `app/api/extract/route.ts` (`functionId: "extract"`)
- `app/api/url/fetch/route.ts` (`functionId: "url-fetch"`)
- `app/api/ai/command/route.ts` (`functionId: "editor-command"`)
- `lib/server/chat/suggestions.ts` (`functionId: "chat-suggestions"`)

All six call sites reuse the same `metadata` shape so the dashboard
groups them as a coherent unit.

### Agent-py / agent-ts (deferred to commit 2)

- **agent-py**: add `opentelemetry-instrumentation-fastapi` +
  `opentelemetry-exporter-otlp-proto-http` to `pyproject.toml`.
  Set `OTEL_EXPORTER_OTLP_ENDPOINT` →
  `${LANGFUSE_HOST}/api/public/otel`. Langfuse documents this exact
  endpoint as their OTel ingest path.
- **agent-ts**: add `@opentelemetry/api` +
  `@opentelemetry/instrumentation-http` to package.json. Same
  endpoint via env.

Both services' instrumentation lives in their respective
`main.py` / `server.ts` files, gated on `LANGFUSE_HOST` being
present — identical "empty env → no exporter" semantic as Next.js.

### Cost groundwork — `workspaceId` continues to be the unit

The `workspace:<id>` tag already lands on every gateway-routed
chat turn (PR #166). Langfuse reads it from `langfuse.tags` and
groups the cost view by it; the "per-workspace dashboard" line in
the cohort survey was speculatively about Vercel's dashboard, but
the same tag works in Langfuse natively. Free win.

## Sequencing — one PR, three commits + one deferred

1. **Commit 1 — Next.js + hosted free tier.** `instrumentation.ts`
   + one-line `experimental_telemetry` on all six chat-shaped
   routes. Documentation in `.env.example` for
   `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`.
   New compose-file stanza for self-host commented out — turn-on
   guide in the README. Tests: assert the `experimental_telemetry`
   object is shaped correctly when the env is set; absent when
   it isn't.
2. **Commit 2 — agent-py + agent-ts.** OTel instrumentation in
   both services, env-gated. Tests: smoke test that the
   `set_tracer_provider` is called when env is set; no-op when
   unset.
3. **Commit 3 — docs.** `CLAUDE.md` section explaining the trace
   schema (`langfuse.session.id` = conversationId, etc.);
   ROADMAP / MASTER_PLAN updates; archive the plan.

**Deferred to a follow-up PR (NOT this one):**
- LLM-as-judge evals (Langfuse Datasets + LLM-as-judge templates).
- Prompt management for system prompts (Langfuse Prompts surface).
- Per-skill span enrichment (`webSearch` retrieval results,
  `searchFiles` rank scores). v1 captures these implicitly via the
  AI SDK tool-call spans; deeper enrichment when there's a
  concrete debugging need.

## Tests

- **`instrumentation.test.ts`** — assert `registerOTel` is called
  with the right service name when the env is set; not called when
  the env is empty. Tests use `vi.mock`/`bun:test` mocks on
  `@vercel/otel`.
- **`telemetry-metadata.test.ts`** — extract a pure helper
  `buildTelemetryMetadata({ conversationId, workspaceId, modelId })`
  so the metadata shape is unit-testable without spinning up the
  whole AI SDK. Cases: anonymous (no conversationId), no workspace,
  full happy path. Same pattern as the gateway tags PR (#166).
- **No new route-handler integration test scaffold** — same
  rationale as #166: the change is a one-line field on existing
  `streamText` calls; standing up route-handler tests for this
  is not proportional.
- **Manual smoke on the Langfuse hosted dashboard** post-deploy:
  send a chat turn, confirm the trace tree appears with the right
  tags, the cost view groups by `workspace:<id>`, and tool calls
  nest under the model call.

## What's NOT in scope

- **EE-gated features.** Project-level RBAC, audit logs, retention
  policies, SSO enforcement, SCIM, Dataset Runs (the playground).
  All licensed; ignore until there's a concrete ask.
- **Existing rate-limit / idle-watchdog telemetry.** Those emit
  to `console.warn` today; not worth re-wiring through OTel just
  because Langfuse is present.
- **Frontend tracing.** Browser-side OTel exporters are noisy +
  blocked by ad blockers; the server-side trace tree already
  captures the API call boundary, which is the right level for
  debugging chat issues.
- **Tracing in the worker poller loops** (agent-py, agent-ts).
  Long-running spans; need a different OTel pattern (each iteration
  a child span under a session-length parent). Out of scope until
  someone has a worker-debugging need.

## Open questions before commit 1

1. **Langfuse OSS vs Cloud free tier for the initial pilot.**
   Hosted = zero infra; self-host = no third-party data leaks.
   **Default: hosted Cloud free tier for the first 30 days; flip
   the `.env` to a self-host stack once the data shape is
   proven.**
2. **Trace data retention.** Cloud free tier caps at 30 days;
   self-host is unlimited. Not a code question — operational.
3. **Sensitive-input recording.** Some prompts contain user
   uploads / pasted snippets. `recordInputs: true` means Langfuse
   sees them. **Default: `recordInputs: true` until a privacy
   constraint surfaces; the helper allows turning it off per call
   if a route flags itself sensitive.**

## Reopen triggers

A v2 of this plan justifies itself when:
- Eval surface (LLM-as-judge templates + Datasets) becomes
  worth the EE license cost, OR
- A second observability target (Honeycomb, Phoenix, custom) joins
  Langfuse and we need an abstraction layer over the metadata
  shape, OR
- Span volume requires sampling decisions (today's traffic is
  small enough that 100% sampling is fine).
