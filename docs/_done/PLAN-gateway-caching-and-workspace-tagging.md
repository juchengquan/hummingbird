# Plan: Vercel AI Gateway per-workspace tagging (+ caching note)

Status: **Part 2 shipped — Part 1 closed (won't do without a Vercel-gateway
commitment).** Zero migrations, zero new env vars, zero new dependencies.
Item #4 from `docs/PLAN-cross-product-inspirations.md`.

> **Closed-out note (2026-06-06).** Per-workspace tagging (Part 2) shipped
> in [#166](https://github.com/juchengquan/hummingbird/pull/166). Part 1
> (caching) is **closed as won't-do**, not deferred — Hummingbird's
> default provider mix (`gateway`, `minimax-cn`, `ollama`, `openrouter`)
> doesn't pin Vercel as the primary path, and every caching sub-task
> below requires either Vercel-dashboard access (sub-task 1) or commits
> to a per-provider caching mechanism (sub-task 2). The prefix-stability
> work (sub-task 3) is universally valid but earns its keep only against
> a measured cache miss in production. Reopen this file when (a)
> production traffic concentrates on a single provider AND (b) telemetry
> shows you're paying for a cacheable prefix that isn't being cached.

## SDK reality check (read this first)

The original framing of this item — "`caching: 'auto'` + `metadata.workspaceId` in one
`streamText` call" — was speculative; the installed SDK doesn't expose either field under
those exact names. Concretely, after walking the installed and latest gateway SDKs:

- `@ai-sdk/gateway@1.0.15` (installed, transitive via `ai@5.0.28`) declares
  `gatewayProviderOptions = z.object({ order: z.array(z.string()).optional() })`. Only
  `order` is typed.
- `@ai-sdk/gateway@3.0.125` (latest) adds typed `tags: string[]`, `user: string`,
  `only`, `sort`, `models`, `byok`, `serviceTier`, `zeroDataRetention`,
  `disallowPromptTraining`, `hipaaCompliant`, `quotaEntityId`, `providerTimeouts`. Still
  no `caching` field.
- **No version** of the gateway SDK exposes a `caching: 'auto'` flag. The cache-pricing
  fields (`cachedInputTokens`, `cacheCreationInputTokens`) are on the model metadata —
  showing the gateway already meters cache reads when they happen — but the *control*
  surface for telling the gateway to insert per-provider cache hints isn't in the SDK
  schema today.

Two practical consequences:

1. The shipping artefact in this PR is **Part 2 (per-workspace tagging) only**. Part 1
   (caching) is split off into a follow-up — see "Caching — what we know" below.
2. The tags are written by name (`tags: ['workspace:<id>']`). They run through the AI SDK
   even though `1.0.15`'s Zod schema doesn't declare `tags` — `streamText` types
   `providerOptions` as `Record<string, Record<string, JSONValue>>` so unknown keys flow
   verbatim to the gateway body; the server reads them. We get the per-workspace
   dashboard view without bumping the SDK.

## Why

**Per-workspace dashboard visibility.** The Vercel AI Gateway dashboard already groups by
model, route, and key. Adding `tags: ['workspace:<workspaceId>']` makes it group by
workspace too — per-workspace cost, latency, error rate, all in one filter. No Langfuse,
no LiteLLM, no new infra. Lands the structured tag now so when Langfuse (item #10) arrives,
the same tag propagates into OTel.

A second tag (`model:<modelId>`) costs nothing and gives a per-model breakdown that's
slightly more granular than the dashboard's built-in model facet (catches retries +
fallbacks the dashboard sometimes collapses).

## Non-goals — what this PR is NOT

- **Not caching.** Split out. See "Caching — what we know" below.
- **Not Langfuse.** Item #10 owns full distributed tracing + LLM-as-judge.
- **Not LiteLLM virtual keys / per-workspace dollar budgets.** Different cohort, needs a
  writable usage store. Vercel's dashboard is read-only.
- **Not `metadata.userId` / `gateway.user` tagging.** The chat route doesn't fetch a user
  today; adding `getSupabaseServerClient().auth.getUser()` on the hot path would cost a
  per-turn Supabase round-trip (~50–100 ms). And `workspace:<id>` is already a strict
  superset of "which user" — workspaces have one owner — so per-user reports stay
  achievable by joining workspace → owner downstream. Deferred until there's a concrete
  per-user dashboard ask.
- **Not provider-side changes for agent-py / agent-ts** — they call `@ai-sdk/anthropic`
  direct, not through the Vercel Gateway. They get observability through the Langfuse
  roll-up (item #10), not through this PR.

## Surface area

One server-only change in `app/api/chat/route.ts` — a `providerOptions.gateway.tags`
field on the existing `streamText` call. The wire schema already carries `workspaceId`;
no client change. No new dependencies.

```ts
streamText({
  abortSignal: upstreamSignal,
  model: selectModel(modelId),
  system: buildSystemPrompt({ /* …existing… */ }),
  messages: body.messages as ModelMessage[],
  ...(body.workspaceId
    ? {
        providerOptions: {
          gateway: {
            // `tags` is a free-form string[] on the gateway dashboard.
            // Use `key:value` shape per Vercel's own docs example so the
            // dashboard's tag-grouping renders coherent buckets.
            tags: [
              `workspace:${body.workspaceId}`,
              `model:${modelId}`,
            ],
          },
        },
      }
    : {}),
  // …existing tools / stopWhen / prepareStep…
})
```

**Why `providerOptions.gateway.*` and not raw headers.** The AI SDK's `streamText`
serialises `providerOptions` into the request body verbatim (`SharedV2ProviderOptions =
Record<string, Record<string, JSONValue>>`). The gateway server reads them from the body.
The provider-creation `headers` field on `createGatewayProvider()` is set once per
provider instance, not per-request — wrong tool for per-request tagging.

**Why this is safe on non-gateway routes.** `selectModel()` returns either a Gateway model
(most paths), an Anthropic model (`minimax-cn` Anthropic-compatible route), or an
OpenAI-compatible model (self-host / OpenRouter / vLLM / Ollama). Only the Gateway
client's body construction reads `providerOptions.gateway`; the others ignore the entire
`gateway` namespace. Hard no-op outside the gateway path, no branching.

**Why guard on `body.workspaceId`.** Signed-out / no-workspace usage skips the whole
`providerOptions` block rather than fabricating a `workspace:undefined` tag bucket on the
dashboard. Clean facets > noisy ones.

## Caching — research notes (closed; reopen if production traffic demands it)

Vercel's docs talk about "automatic prompt caching" but the SDK surface is silent on a
`caching: 'auto'` opt-in. Most likely behaviour:

1. **Gateway-side automatic caching when supported.** The gateway server may already
   insert the right per-provider cache-breakpoint hint (Anthropic `cache_control`, Bedrock
   `cachePoint`, etc.) when the prefix is large enough and the model supports it. If so,
   we're already getting cache hits in production without any code change — the
   `cachedInputTokens` field on the dashboard / usage response confirms or refutes this
   per-call.
2. **Anthropic-only opt-in via the Anthropic provider.** `@ai-sdk/anthropic@^2.0.79`
   exposes `providerOptions.anthropic.cacheControl = { type: 'ephemeral', ttl?: '5m' |
   '1h' }`. This is the **provider-side** cache-control breakpoint. Whether it works
   when routed through the gateway is unverified.

### Per-provider applicability

The caching story is not provider-agnostic. Each path Hummingbird routes to has its own
mechanism (or none):

| Path | Caching mechanism | Sub-tasks valid here |
|---|---|---|
| **Vercel AI Gateway** | Auto-cache (maybe; SDK is silent — see above) | 1 (dashboard check), maybe 2 (cacheControl through the gateway is unverified), 3 (prefix stability) |
| **Direct Anthropic** (`agent-py`, `agent-ts`, `minimax-cn` provider) | Native Anthropic `cache_control: { type: 'ephemeral' }` | 2 (cleanest path — no gateway translation), 3 |
| **OpenRouter** (`via: "openrouter"`) | OpenRouter's own caching (different headers + body shape — `usage.include` + `cache_control`) | OpenRouter-specific version of 2, plus 3 |
| **Ollama / vLLM / LM Studio** (`allowInsecureBaseUrl`) | None — local model in memory; no wire cache | 3 only (no cache to hit either) |

### Sub-task triage

- **Sub-task 1 (dashboard check)** — Vercel-only. Requires dashboard access + production
  traffic on the gateway path. Closed in this plan.
- **Sub-task 2 (per-provider cache opt-in)** — different research per provider. Closed
  until a single provider concentrates enough traffic to justify the dig.
- **Sub-task 3 (prefix-stability invariants)** — universally valid, but pays off only
  against a measured cache miss. The fixes below are documented for the day that miss
  shows up; closed until then.

## Cache-hit invariants — research notes (closed)

Independent of which opt-in mechanism eventually lands, automatic caching only pays off
when the prefix is byte-stable turn-to-turn. Known potential miss sources in Hummingbird's
current prompt assembly that a future caching follow-up should verify:

1. **`Conversation.systemPrompt` edits (PR #165).** Editing thread instructions changes
   the prefix and invalidates the cache for that conversation until the new prefix
   accrues at least one reuse. Acceptable — deliberate edit.
2. **MCP tool-list ordering.** `loadEffectiveMcpServers` returns servers in whatever
   order the storage layer yields. If iteration order isn't stable across requests, the
   tool catalogue text shuffles every turn → cache miss. Verify or pin a deterministic
   sort (by server id) in `buildSystemPrompt`'s MCP-note builder.
3. **Attachment summaries.** `resolveAttachments` runs `Promise.all` over MCP resources;
   results are pushed in resolution order, not request order. Could shuffle the
   attachment block turn-to-turn. Same fix shape: stable sort key when assembling the
   prompt.

These are observations, not open work — closed until production traffic shows a
cacheable prefix isn't getting cached.

## Tests

Skipped. The change is one server-only field on one `streamText` call. There's no
existing route-handler test scaffold in `app/api/` and standing one up just for a
4-line wiring change isn't proportional. Instead:

- **Type-check** (`bun run typecheck`) confirms the body well-formed.
- **Manual smoke** on the Vercel AI Gateway dashboard post-deploy: send a chat turn with
  a real workspace; confirm the tag bucket appears. Documented in the PR description.

Once Langfuse lands (item #10), the same tag flows into OTel and a unit test on the
tag-emission shape becomes worth writing — at that point the assertion is "the OTel span
carries the right attribute," which has a tractable test target.

## Sequencing

Single PR:

1. **Commit 1 — code change.** `providerOptions.gateway.tags` block in
   `app/api/chat/route.ts`.
2. **Commit 2 — docs.** Plan update (this file), `PLAN-cross-product-inspirations.md`
   note that #4-Part-2 has shipped + #4-Part-1 is the verification follow-up, and
   `MASTER_PLAN.md` reflects the same.

## Open question

**Should agent-py + agent-ts go through the Vercel Gateway, too?** Today they hit
Anthropic direct. Routing through the gateway would:

- Surface them on the per-workspace dashboard the same way as Next.js chat.
- Unify caching, retries, and routing under one config.
- Inherit the gateway's pricing markup (today: zero) and rate limits.
- Lose the `ANTHROPIC_BASE_URL` direct-endpoint override (used in one in-region
  deployment + the no-network-egress test setup).

Defer until item #10 (Langfuse) is sequenced. Once Langfuse owns observability, the
"why route through the gateway" calculus shifts.

## Sources

- [Vercel AI Gateway — observability & tags](https://vercel.com/docs/ai-gateway/observability)
- [Vercel AI Gateway — automatic prompt caching](https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching) (the verification target)
- `@ai-sdk/gateway@3.0.125` docs (in-package `docs/00-ai-gateway.mdx`) — confirmed the
  `user` + `tags` provider options' wire shape via the SDK source.
- `docs/PLAN-cross-product-inspirations.md` — parent menu, item #4.
