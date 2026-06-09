# Plan: Smart model routing (RouteLLM-style)

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(fourth research round, 2026-06-09) to **Next**. Scope: **M** (one PR).
Origin: RouteLLM (ICLR 2025, open-source) — see [Sources](#sources).

## Why

RouteLLM reaches ~95% of strong-model quality at ~14–26% strong-model
calls — a 75–85% cost cut — by routing each prompt to the cheapest
*capable* model via a complexity classifier. Hummingbird already has
`openrouter/auto` (which routes *within* OpenRouter's catalogue); this
is a **Hummingbird-level `model: "auto"`** that routes across the whole
provider set it already supports (Anthropic / Vercel gateway / Ollama /
OpenRouter) by query complexity — cheap local/fast model for easy turns,
strong model for hard ones.

The plumbing is mostly there: `lib/server/model-provider.ts` already
dispatches across providers, `config/models.json` already carries
per-model metadata, and the model picker is a known surface. The new
piece is the router (a classifier + a strong/weak pair config).

## Non-goals — what this is NOT

- **Not removing manual model choice.** `auto` is a *new option*
  alongside explicit model selection; users who pin a model keep it.
- **Not consensus/fusion across models.** That's Beam (inspirations
  #8). This routes to *one* model per turn.
- **Not training a router from scratch.** Use RouteLLM's open-source
  router (matrix-factorisation / BERT classifier) or a small
  classifier; pluggable.
- **Not cross-provider quality guarantees.** The router is best-effort
  + escalates on low confidence; users can always pin.

## Decisions to pin before code

1. **Router placement.** Server-side in `lib/server/model-provider.ts`
   (or a `lib/server/routing/` module it calls): when the requested
   model is `auto`, classify the prompt and resolve to a concrete model
   id before dispatch. Keeps routing off the client.
2. **Strong/weak config.** A workspace-level (or global) routing config:
   `{ strong: modelId, weak: modelId, threshold }`. Defaults from
   `config/models.json` (e.g. a Claude strong + a Haiku/Ollama weak).
3. **Classifier.** Start with RouteLLM's lightweight router (or a small
   prompt-complexity classifier — pairs with the prompt-optimisation
   classifier work). Pluggable behind a `Router` interface so it can be
   swapped/improved.
4. **Escalation (cascade) — phase 2.** Optional: run weak first, and if
   a confidence signal is low, escalate to strong. v1 is single-shot
   routing (classify → pick → run).
5. **Transparency.** The chosen model is surfaced on the message (a
   small "routed to X" affordance) so routing is never opaque.
6. **Interaction with reasoning-effort.** Routing picks the *model*;
   the (sibling) reasoning-effort control picks *depth* within a
   reasoning model. They compose.

## Shape — code surface

### Router — `lib/server/routing/`

```ts
export interface Router {
  route(prompt: RouteInput): Promise<{ modelId: string; reason: string }>
}
export function selectRouter(config: RoutingConfig): Router
```

- A RouteLLM-backed (or classifier-backed) impl; `RouteInput` =
  last user message + a cheap feature summary; output = a concrete model
  id from the strong/weak pair.

### Dispatch — `lib/server/model-provider.ts`

When `body.model === 'auto'`, call `router.route(...)` → resolve to a
concrete id, then dispatch as today. The rest of the path is unchanged.

### Config + wire

- `config/models.json` — a synthetic `auto` entry + a `routing` block
  (strong/weak/threshold).
- The model picker lists **Auto** at the top; `apiClient` sends
  `model: 'auto'`. The response carries the resolved model id for the
  "routed to X" affordance.

## Sequencing — one PR, three commits

1. **Commit 1 — router interface + config + single-shot routing.** The
   `Router` interface + a first classifier impl + the `auto` dispatch
   branch in `model-provider.ts`; resolved-model id surfaced on the
   response.
2. **Commit 2 — picker + transparency UI.** `Auto` in the model picker;
   the "routed to X" affordance on the message; per-workspace routing
   config UI.
3. **Commit 3 (phase 2) — cascade/escalation.** Run weak, escalate on
   low confidence; metric to tune the threshold.

## Tests

- **Router (commit 1)** — easy prompt → weak model; hard prompt →
  strong; respects the configured pair; pure with a stubbed classifier.
- **Dispatch branch (commit 1)** — `model: 'auto'` resolves before
  dispatch; explicit model ids bypass the router (regression guard).
- **Manual smoke** — a trivial prompt routes to the cheap model
  (visible in the affordance + cost); a hard one routes to the strong
  model; pinning a model overrides routing.

## Open questions before commit 1

1. **Classifier cost/latency.** A classifier call before every turn
   adds latency. **Default: a *local/tiny* classifier (or RouteLLM's
   non-LLM matrix-factorisation router) so routing is ~free; never a
   strong-model call to decide.**
2. **Default strong/weak pair.** **Default: derive from
   `config/models.json` capability tiers; let the workspace override.**
3. **Streaming + routing.** Routing resolves before the stream starts,
   so no streaming complication. Cascade (commit 3) is the only case
   that may restart a stream — handle by only escalating pre-first-token.

## Reopen / future work

- **Per-skill routing** — force strong for agent/research, weak for
  quick chat.
- **Budget-aware routing** — bias toward weak as a workspace nears a
  spend cap (pairs with a future cost-budget feature).
- **Beam convergence** (#8) — consensus across N models is the
  multi-model sibling of single-best routing.

## Sources

- [RouteLLM](https://routellm.dev/)
- [LLM model routing guide 2026](https://www.burnwise.io/blog/llm-model-routing-guide)
- [AI agent model routing (2026)](https://zylos.ai/research/2026-03-02-ai-agent-model-routing/)
