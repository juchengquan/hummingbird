# Plan: Citation & verifiability layer

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(fourth research round, 2026-06-09) to **Next**. Scope: **M–L** (opt-in;
strongest in research mode). Origin: 2026 citation-hallucination
research — see [Sources](#sources).

## Why

Citation-hallucination rates run 14–95% across vendors. Hummingbird
already renders **inline citations from web search** (and surfaces a
Sources strip), but those citations are *decorative* — nothing checks
that a cited source actually supports the claim. The 2026 pattern is a
**verification layer**: ground each claim against the retrieved sources,
flag unsupported statements, and surface a confidence signal
(chain-of-verification / retrieval-grounded checking).

Hummingbird is well-placed: it already has the retrieval surfaces
(`webSearch` results + `searchFiles` over workspace files) and the
inline-citation rendering. A verify pass turns "here are some links"
into "these claims are supported; this one isn't."

## Non-goals — what this is NOT

- **Not always-on.** Verification adds a model call; it's opt-in
  (and on by default in Deep Research mode, where it matters most).
- **Not a truth oracle.** It checks claim↔source support against the
  *retrieved* evidence, not the world. Unsupported ≠ false; it's "not
  grounded in the cited sources."
- **Not a new retrieval system.** Reuses `webSearch` + `searchFiles`
  results already gathered in the turn.
- **Not blocking.** Flags + confidence are advisory; nothing is
  suppressed.

## Decisions to pin before code

1. **When it runs.** A post-turn pass over the assistant message when
   the turn used retrieval (web search / `searchFiles`). Opt-in toggle;
   default-on in Deep Research mode (which already force-enables
   `searchFiles` + a sources block).
2. **Method.** Retrieval-grounded verification: split the answer into
   claims, match each to the turn's cited sources, classify
   supported / unsupported / partial with a verifier model call.
   Chain-of-verification as the technique.
3. **Surface.** Inline markers on unsupported claims (a subtle
   underline + tooltip "not found in cited sources") + a per-message
   confidence summary ("8/9 claims grounded"). Reuses the existing
   citation-rendering layer.
4. **Cost.** One extra (cheap-model) verification call per verified
   message; only on retrieval turns; opt-in elsewhere. Budget-gated.
5. **Verifier model.** A different/cheaper model than the answerer
   (cross-checking your own output is weaker). Configurable.

## Shape — code surface

### Verifier — `lib/server/verify/`

```ts
export interface ClaimCheck { claim: string; status: "supported" | "unsupported" | "partial"; sourceIds: string[] }
export async function verifyAnswer(answer: string, sources: RetrievedSource[], model: string): Promise<ClaimCheck[]>
```

- Splits the answer into claims, prompts the verifier model with the
  claims + the turn's retrieved sources, returns per-claim grounding.
  Pure prompt builder + a thin model call.

### Emission — `app/api/chat/route.ts`

After the turn settles on a retrieval turn (and verification is on),
run `verifyAnswer` over the gathered `webSearch`/`searchFiles` sources;
emit a new `data-verification` part (`{ checks: ClaimCheck[],
confidence }`) — beside `data-suggestions` / `data-tool-image`.

### Wire + render

- `lib/client/chat/sse-frame-translator.ts` — `data-verification` →
  `{ type: "verification", ... }`.
- `messages` slice — `setMessageVerification(messageId, checks)`.
- `components/panels/chat-message.tsx` — render unsupported-claim
  markers + the confidence summary, layered onto the existing citation
  rendering.

## Sequencing — shipped across several PRs

1. **Commit 1 — verifier (pure + call).** ✅ [#199] Claim-splitting +
   the verification prompt + `verifyAnswer` (`lib/shared/verify.ts` +
   `lib/server/verify/`); tested against fixture answer+sources.
2. **Commit 2 — emit + render.** ✅ [#200] The `data-verification`
   part, translator, store, the confidence chip + flagged-claims
   disclosure; account-menu opt-in toggle. (Inline span markers within
   the rendered markdown deferred — the disclosure carries the same
   info.)
3. **Commit 3 — Sources-strip support counts.** ✅ [#201]
   `countSupportPerSource` + per-source "supports N claims" badges.
4. **Deep Research integration.** ✅ Verification on research reports,
   which run through the **task/agent pipeline** (agent-py), not the
   inline chat route. Shared event-IR carries `ResultEvent.verification`
   (`events.ts` / `wire.ts` / `emitter.ts` / `project.ts`); a Python
   verifier port (`services/agent-py/src/agent_py/verify.py`) runs at
   settlement via a runner `finalize` hook, gated on research mode +
   `VERIFY_MODEL`; the client folds `view.verification` onto the result
   `Message` so the existing UI renders. **Limitations:** runs only when
   a research run settles in its first chunk (the per-chunk accumulator
   is complete then); the verifier is same-family (Anthropic) since
   agent-py has no cross-family provider; agent-ts stays stubbed until
   its real-step phase.

   Remaining: cross-chunk verification (read the full event log at
   settle), a cross-family verifier, and true inline span markers.

## Tests

- **Claim split + check (commit 1)** — an answer with a supported and
  an unsupported claim yields the right per-claim statuses against
  fixture sources; pure builder + stubbed verifier.
- **Translator (commit 2)** — `data-verification` → frame; malformed →
  null.
- **No-op off retrieval turns (commit 1)** — a turn with no sources
  doesn't run verification (regression/cost guard).
- **Manual smoke** — a web-search answer flags a fabricated claim;
  confidence summary reflects it; research mode runs it automatically.

## Open questions before commit 1

1. **Claim granularity.** Sentence-level vs assertion-level.
   **Default: sentence-level claims that carry a citation marker;
   uncited prose is left unmarked (it's not claiming a source).**
2. **Verifier model.** **Default: a cheap cross-family model; never the
   same instance that wrote the answer.**
3. **False-positive risk.** Over-flagging erodes trust. **Default: tune
   conservative — only flag clearly-unsupported claims; "partial" stays
   subtle.**

## Reopen / future work

- **External citation grounding** — verify cited *metadata* (does this
  paper/URL exist + say this?) à la CiteCheck, not just retrieved-source
  support.
- **Confidence in the model stream** — token-level confidence signals
  if providers expose them.
- **Pairs with guardrails** — verification + moderation as a combined
  "trust" layer.

## Sources

- [CiteCheck — retrieval-grounded citation verification](https://arxiv.org/html/2605.27700v1)
- [Preventing LLM hallucinations 2026](https://keymakr.com/blog/preventing-llm-hallucinations-techniques-best-practices-2026/)
- [Awesome hallucination detection](https://github.com/EdinburghNLP/awesome-hallucination-detection)
