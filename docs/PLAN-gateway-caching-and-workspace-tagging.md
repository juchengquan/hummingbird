# Plan: Vercel AI Gateway `caching: 'auto'` + per-request `workspace_id` tagging

Status: **planning** — small, scoped slice. Zero migrations, zero new env vars, zero new
dependencies. Item #4 from `docs/PLAN-cross-product-inspirations.md`.

## Why

Two thin slices of value off one Gateway feature.

**Part 1 — automatic prompt caching.** Hummingbird's `app/api/chat/route.ts` system prompt
is the same prefix every turn for a given conversation: workspace voice + `Conversation.systemPrompt`
+ skills note + MCP tool list + attachment summaries. Anthropic and several other providers
charge ~10% of the normal input-token rate on cached prefix reads, but only if the request
carries the correct per-provider cache-breakpoint hint (Anthropic's `cache_control` block,
Bedrock's `cachePoint`, etc.). The Vercel AI Gateway's `caching: 'auto'` option inserts those
hints transparently on the request body before forwarding upstream — so Hummingbird can opt
in without rewriting the prompt-builder for each provider's idiosyncratic cache shape. The
cost win is largest on multi-turn conversations with non-trivial workspace + thread
instructions + MCP tool catalogues.

**Part 2 — `workspace_id` on the Gateway dashboard.** The Vercel AI Gateway dashboard already
groups requests by model, route, and API key. The same dashboard supports custom request
properties (sent as `metadata` on the call), which become filter facets. Tagging every
chat-route call with the active workspace id (and incidentally the user id, when there's a
Supabase session) gives per-workspace cost and latency breakdowns for free — no Langfuse, no
LiteLLM, no new dashboards. Lands the structured tag now so when Langfuse arrives (item #10
in `PLAN-cross-product-inspirations.md`) the same tag flows into OTel.

Both parts are cheap to ship, easy to undo, and orthogonal — the cache flag and the metadata
field are independent toggles on the same `streamText` call.

## Non-goals — what this PR is NOT

- **Not Langfuse.** Item #10 is the full distributed-tracing + LLM-as-judge story. This is a
  pre-cursor that gets the workspace-id tag flowing today; it does not stand in for the
  Langfuse work.
- **Not LiteLLM virtual keys / per-workspace dollar budgets.** That's a separate cohort
  (observability item) and needs a Gateway-or-proxy with a writable usage store. Vercel's
  dashboard is read-only; budgets aren't enforceable from here.
- **Not OpenRouter / `openrouter/auto` routing.** Item #3. Different provider, different
  surface.
- **Not provider-side caching for the agent-py / agent-ts services** — they call
  `@ai-sdk/anthropic` directly with `ANTHROPIC_API_KEY`, NOT through the Vercel Gateway, so
  Part 1 is structurally Next.js-only. See "Open question" below.

## Surface area

One call site for the cache flag (`streamText` in the Next.js chat route). One per-request
metadata field added to the same call. That's it. The wire shape (`ChatRequestSchema`)
already carries `workspaceId`; no client change needed.

### Part 1 — `caching: 'auto'`

`@ai-sdk/gateway`'s `createGateway()` returns a provider whose model factory accepts
`providerOptions.gateway.caching` per request. The `app/api/chat/route.ts` `streamText` call
becomes:

```ts
streamText({
  abortSignal: upstreamSignal,
  model: selectModel(modelId),
  system: buildSystemPrompt({ /* …existing… */ }),
  messages: body.messages as ModelMessage[],
  providerOptions: {
    gateway: {
      // Insert per-provider cache-breakpoint hints automatically. No-op on
      // non-gateway routes (minimax-cn anthropic-compat) because those
      // models resolve to a different provider id and never see this key.
      caching: 'auto',
      // Per-workspace dashboard facet. Always set when present; omitted
      // for signed-out usage so we don't fabricate an empty bucket.
      ...(body.workspaceId
        ? { metadata: { workspaceId: body.workspaceId } }
        : {}),
    },
  },
  // …existing tools / stopWhen / prepareStep…
})
```

**Why `providerOptions.gateway.*` and not a header.** The AI SDK Gateway provider exposes
the cache flag through `providerOptions` (typed by the SDK), not through raw HTTP headers.
That's the seam that survives gateway SDK version bumps. Setting `Anthropic-Cache-Control`
manually would only work for the Anthropic path, miss every other provider, and break the
"unified surface across N providers" thesis of using the gateway in the first place.

**Why this is safe on non-gateway routes.** `selectModel()` returns either an Anthropic
client (for `minimax-cn` routes) or an OpenAI-compatible client (for self-hosted /
OpenRouter routes) or a Gateway client. Only the Gateway client reads `providerOptions.gateway`;
the others ignore unknown provider option blocks. So the same flag is a hard no-op outside
the gateway path — no branching, no per-model `if`.

### Part 2 — per-workspace + per-user dashboard facets

`providerOptions.gateway.metadata` is the field. Two keys, both optional:

```ts
metadata: {
  ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
  ...(userId ? { userId } : {}),
}
```

Where `userId` comes from the Supabase session that already lives in `app/api/chat/route.ts`
adjacent code (anonymous turns have no userId — `metadata` simply omits the key, no empty
string). One snake_case-vs-camelCase decision: the Gateway dashboard treats metadata keys as
opaque strings — match the rest of the codebase's camelCase so future OTel propagation maps
1:1.

**Privacy posture.** Metadata travels with the API request to the gateway. Vercel retains it
for billing-window dashboards. The workspace id is a UUID-shaped opaque identifier; the user
id is also an opaque uid. Neither contains PII directly. We do **not** tag with the model id,
conversation id, message contents, or any free-text field — those would either bloat the
dashboard or leak content into a third party. The metadata stays minimal.

## What about agent-py + agent-ts?

Both services call `@ai-sdk/anthropic` (TS) / the Anthropic Python SDK (py) directly with
`ANTHROPIC_API_KEY`, not through the Vercel AI Gateway. So:

- **Part 1 (caching).** Doesn't reach those paths today. Two options for parity:
  1. **Add Anthropic-native cache-breakpoint hints** in `services/agent-ts/src/chat.ts` and
     `services/agent-py/src/agent_py/chat.py` — manually attach `cache_control: { type:
     'ephemeral' }` to the system prompt block and the tool definitions block. Same on-wire
     effect as `caching: 'auto'` for the Anthropic provider, but limited to Anthropic.
     Manual; small.
  2. **Route the services through the Vercel Gateway** by swapping `createAnthropic({ apiKey
     })` for the Gateway SDK behind an env flag. Larger blast radius — the services would
     start consuming the gateway's Anthropic quota and inherit its rate-limit behaviour.
  Recommend **Option 1 in a follow-up PR**, not in this one. Keeps the Next.js plan small
  and lets the services adopt cache hints on their own timeline.
- **Part 2 (workspace tagging).** No gateway dashboard to populate. Defer to Langfuse (item
  #10) — that's where the services will get per-workspace observability.

The plan therefore explicitly **does not** modify the agent-py or agent-ts chat code. They
continue to work as before, identical wire format.

## Cache-hit invalidation — what to watch out for

The economics only materialise when the cached prefix is genuinely identical turn to turn.
Three known sources of false-miss in Hummingbird's current prompt assembly:

1. **`Conversation.systemPrompt` edits (PR #165).** Editing thread instructions changes the
   prefix and invalidates the cache for that conversation until the new prefix accrues at
   least one reuse. Acceptable — this is a deliberate edit, not noise.
2. **MCP tool-list ordering.** `loadEffectiveMcpServers` returns servers in whatever order
   the storage layer hands them back. If the iteration order isn't stable across requests,
   the tool catalogue text shuffles every turn → cache miss. **Verify or pin a deterministic
   sort** (by server id) inside `buildSystemPrompt`'s MCP-note builder. Worth a small fix
   here even if the audit shows it's already stable, because the cache cost of an
   accidentally-shuffled tool list is real.
3. **Attachment summaries.** `resolveAttachments` runs concurrently and `mcpRequests`
   results are pushed in resolution order, not request order. If the model sees the
   attachment block in a different order each turn → cache miss. Same fix: stable
   ordering when assembling the prompt.

We are not paying down those issues in this PR — they may already be deterministic. Item
list, not action list. If a follow-up audit shows non-determinism, the fix is a sort key,
not a redesign.

## Tests

- **Unit — `app/api/chat/route.test.ts` (new — there isn't one today).** Mock `streamText`,
  fire one POST with `workspaceId: "ws-abc"`, assert the SDK call received
  `providerOptions.gateway.caching === 'auto'` and `providerOptions.gateway.metadata.workspaceId ===
  "ws-abc"`. One test per branch: workspaceId present, workspaceId absent (metadata key
  omitted, not empty), userId present, userId absent. Four cases. Tiny.
- **No new wire-shape test** — `ChatRequestSchema` already covers `workspaceId`; the
  `providerOptions` value lives entirely server-side.
- **Manual smoke — the Vercel AI Gateway dashboard** after deploy. Filter by `workspaceId`,
  confirm the bucket appears. Run two turns in the same conversation, confirm the second
  shows cache-read tokens > 0 on the cost view. Documented in the PR description as a
  manual verification step (we don't have a programmatic gateway-dashboard probe).
- **No agent-py / agent-ts test changes** — those services are untouched.

## Sequencing

Single docs-and-code PR, two commits:

1. **Commit 1 — code change.** The `providerOptions.gateway` block in
   `app/api/chat/route.ts`, plus the new unit test file.
2. **Commit 2 — docs.** Update `docs/ROADMAP.md` (move item from planning to shipped) and
   mark item #4 done in `docs/PLAN-cross-product-inspirations.md`.

Could be one commit, but the split keeps the code commit reviewable without the doc churn.

## Open question

**Should agent-py + agent-ts go through the Vercel Gateway, too?** Today they hit Anthropic
direct. Routing them through the Gateway would:

- Unify caching, retries, and routing under one config.
- Surface them on the per-workspace dashboard the same way as the Next.js chat.
- Inherit the gateway's rate limits and pricing markup (today there's no markup, but that's
  a third-party policy we'd be subscribing to).
- Lose the direct-baseURL escape hatch (`ANTHROPIC_BASE_URL` — used for in-region traffic in
  one deployment topology and the no-network-egress test setup).

Defer the decision until item #10 (Langfuse) is sequenced — by then we'll know whether the
"observability + caching + routing" story consolidates around Vercel's gateway or around
Langfuse's OTel + a separate routing tier (e.g. LiteLLM). Land Part 1+2 on the Next.js path
now; revisit the services as part of the larger observability roll-up.

## What's not in scope (revisit later)

- **Cache-aware prompt assembly improvements** — split the prefix into a stable "voice"
  block + a volatile "context" block so a thread-instructions edit doesn't invalidate the
  voice. Separate plan if cache-miss telemetry shows it matters.
- **Bedrock / OpenAI cache-point parity** — `caching: 'auto'` already handles whichever
  providers the gateway supports; we don't need to chase each upstream.
- **`metadata.conversationId`** — the gateway dashboard supports it, but the dashboard's
  cardinality goes up fast (one per conversation per workspace). Hold until we want
  per-conversation forensics, then add behind a debug flag.
- **Cost-budget enforcement.** Gateway dashboard is read-only. Budget enforcement is a
  LiteLLM / Langfuse story, not a Vercel Gateway story.

## Sources

- [Vercel AI Gateway — automatic prompt caching](https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching)
- [Vercel AI Gateway — request metadata](https://vercel.com/docs/ai-gateway/observability) (per-property dashboard filters)
- [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) — the per-provider mechanic `caching: 'auto'` implements transparently
- `docs/PLAN-cross-product-inspirations.md` — parent menu, item #4
