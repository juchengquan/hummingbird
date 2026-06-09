# Plan: Automatic prompt optimisation (GEPA / DSPy)

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(second research round, 2026-06-09) to **Next**. Scope: **M–L** (an
offline/admin loop, not a hot-path change; gated on having an eval set).
Origin: GEPA (ICLR 2026, in DSPy) — see [Sources](#sources).

## Why

Every prompt in Hummingbird is hand-tuned and never measured:

- skill `promptFragment`s (`lib/server/skills/*`),
- persona `systemPrompt`s (`agents` slice),
- prompt-library `template`s (`prompts` slice),
- the **editor command prompts** (`app/api/ai/command/prompt/*` —
  notably `getChooseToolPrompt`, a *classifier* with measurable ground
  truth),
- the `summarize` prompts.

GEPA is a reflective, gradient-free optimiser in DSPy: it reads
execution traces, diagnoses failures in natural language, and evolves a
Pareto frontier of candidate prompts — reportedly +20% over GRPO with
35× fewer rollouts. Pointed at the prompts above + a small labelled set,
it turns artisanal prompt-tuning into a measurable "optimise this
prompt" action. It's the natural partner to the (parked) Langfuse eval
surface: traces in, a better prompt out.

The **`getChooseToolPrompt` classifier is the ideal first target** —
intent classification (generate / edit / comment / table) has clear
ground truth, so optimisation gain is directly measurable.

## Non-goals — what this is NOT

- **Not a hot-path / per-request thing.** Optimisation is an
  offline/admin job. Production keeps running the current prompt until
  a human accepts an optimised candidate.
- **Not model fine-tuning.** GEPA optimises *prompts*, not weights. No
  training infra, no LoRA.
- **Not auto-deploy.** A proposed prompt is reviewed and explicitly
  accepted into the registry/library by a human. Never silently
  swapped.
- **Not for creative prompts without a metric.** Targets prompts with a
  definable success signal (classification accuracy, schema-validity,
  rubric score). "Write a nice intro" isn't optimisable here.

## Decisions to pin before code

1. **Where it runs.** DSPy is Python → a standalone optimiser module
   beside `services/agent-py` (a CLI / admin job, not a request route).
   It reads prompts + eval sets, runs GEPA against the same Anthropic
   models production uses, writes candidate prompts to a review queue.
   **Default: a `services/agent-py`-adjacent CLI, invoked deliberately.**
2. **First target.** `getChooseToolPrompt` (the editor intent
   classifier). Build the eval-set + harness + accept-flow against the
   easiest-to-measure case, then generalise.
3. **Eval-set sourcing.** Three sources, in order of preference:
   (a) a hand-labelled seed set per prompt; (b) accepted/edited
   outcomes mined from history (e.g. which tool the user actually kept);
   (c) traces (once Langfuse lands). **Default: hand-labelled seed for
   the first target; mining + traces later.** This is the real gate —
   no eval set, no optimisation.
4. **Metric per prompt kind.** Classifier → accuracy; structured
   outputs (suggestions / comment / table) → schema-validity + rubric;
   summaries → an LLM-judge rubric. Each target declares its metric.
5. **Accept flow.** A candidate prompt + its before/after metric lands
   in a review surface; a human accepts → the prompt is written to the
   registry (skills/personas/editor prompts) or the prompt library.
   Versioned so a regression can roll back.
6. **Cost containment.** GEPA is rollout-efficient but still spends
   tokens. Cap rollouts per run; run against the cheap model where the
   target uses one (the classifier already uses a fast model).

## Shape — code surface

### Optimiser — `services/agent-py` adjacent

```
services/prompt-optim/                 # standalone uv project (or a module)
  src/prompt_optim/
    targets.py      # registry of optimisable prompts: id, current text, metric, eval-set loader
    eval_sets/      # labelled examples per target (json/jsonl)
    metrics.py      # accuracy / schema-validity / llm-judge rubric metrics
    gepa_run.py     # DSPy GEPA loop: load target + eval set -> evolve -> write candidate
    review.py       # emit candidate + before/after metric to the review queue
```

- A target descriptor ties a prompt id (e.g. `editor.chooseTool`) to
  its current text, a metric fn, and an eval-set path.
- `gepa_run.py` wraps DSPy GEPA; candidates + metrics write to a review
  store (a Supabase `prompt_candidates` table, or just files in v1).

### Review + accept — client

- A small admin surface (behind the Library/Settings) lists pending
  prompt candidates with before/after metric + a diff of the prompt
  text; **Accept** writes the new text to the right home:
  - editor prompts → a config/override read by `app/api/ai/command/`,
  - skill `promptFragment`s → a per-skill override,
  - persona `systemPrompt` / library `template` → the existing slices.
- Versioned via a `promptVersion` field so rollback is one click.

### Wiring the override

Editor command prompts + skill fragments are string constants today.
Add a thin `resolvePromptText(id, fallback)` indirection
(`lib/shared/prompts/registry.ts`) so an accepted optimised version can
override the hard-coded default without a code change. Personas /
library already store editable text in their slices.

## Sequencing — PR series

1. **PR 1 — harness + first target (`chooseTool`).** The optimiser
   project, the classifier eval-set + accuracy metric, a GEPA run that
   produces a candidate + before/after accuracy. Output to files
   (no UI yet). Proves the loop end-to-end on the measurable case.
2. **PR 2 — override indirection + accept flow.** `resolvePromptText`
   indirection for editor prompts + skill fragments; the review/accept
   surface; versioning + rollback.
3. **PR 3 — more targets.** Suggestions + summarize prompts (schema /
   rubric metrics); persona / library prompts.
4. **PR 4 (gated on Langfuse) — trace-fed eval sets.** Mine production
   traces for eval examples instead of hand-labelling.

## Tests

- **Metric fns (PR 1)** — accuracy on a known confusion matrix;
  schema-validity metric flags malformed JSON; rubric metric is
  deterministic given a fixed judge stub. Pure where possible.
- **Override indirection (PR 2)** — `resolvePromptText` returns the
  accepted override when present, the hard-coded fallback otherwise;
  rollback restores the prior version.
- **Accept flow (PR 2)** — accepting a candidate writes the right home
  + bumps the version; the running route picks up the override.
- **Manual smoke** — run the optimiser on `chooseTool` against the seed
  set, confirm the candidate's accuracy ≥ current, accept it, confirm
  the editor route uses the new prompt and can roll back.

## Open questions before PR 1

1. **Eval-set ownership.** Who curates the seed set, and where does it
   live (in-repo vs per-user data)? **Default: in-repo seed sets for
   the built-in prompts (classifier, suggestions, summarize); user
   prompts are opt-in and user-owned.**
2. **Judge model for rubric metrics.** Using the same model family to
   judge its own output is circular. **Default: judge with a different
   model (cross-family) for rubric metrics; classifier/schema metrics
   need no judge.**
3. **DSPy version pinning.** GEPA is young; pin the DSPy version and
   treat the optimiser project as an isolated tool (its deps don't
   touch the runtime services). **Default: isolated `uv` project.**

## Reopen / future work

- **Continuous optimisation** — re-run on a schedule as traces
  accumulate (pairs with scheduled tasks + Langfuse).
- **Per-workspace prompt tuning** — optimise a workspace's persona
  prompts against that workspace's accepted outcomes.
- **A/B in production** — serve candidate vs current to a fraction of
  traffic and pick the winner by live metric (needs the eval/telemetry
  surface first).

## Sources

- [GEPA reflective prompt evolution (DSPy tutorial)](https://dspy.ai/tutorials/gepa_ai_program/)
- [GEPA repo](https://github.com/gepa-ai/gepa)
- [Optimising GEPA for production (Decagon)](https://decagon.ai/blog/optimizing-gepa-for-production)
