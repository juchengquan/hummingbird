# Plan: Deep Research mode

Status: **✅ All 4 phases shipped + wire-up.** Phase 1 ships the
end-to-end loop ([#101](https://github.com/juchengquan/hummingbird/pull/101))
— `/research <goal>` slash, `mode` flag, research-mode system prompt,
"Open in editor" button. Phase 2 ships auto editor hand-off on settle
([#103](https://github.com/juchengquan/hummingbird/pull/103))
— chat message + workspace doc + markdown artifact, resume-on-reload
preserves `mode`. Phase 3 ships workspace-knowledge sources via
`searchFiles` ([#104](https://github.com/juchengquan/hummingbird/pull/104))
— research mode force-enables `searchFiles`; the system prompt
branches files-first when enabled. Phase 4 ships the citation
formatter ([#105](https://github.com/juchengquan/hummingbird/pull/105))
— pure `formatResearchCitations` renumbers inline `[N]` markers and
dedupes the `## Sources` block. Wire-up
([#106](https://github.com/juchengquan/hummingbird/pull/106))
applies the formatter in the Phase 2 auto-handoff so the chat
message, doc, and artifact all carry canonical citations.

Plan promoted from [`SURVEY-market-2026.md` §4.1](../SURVEY-market-2026.md).
Originally lived at `docs/PLAN-deep-research.md`; moved here on
completion per the archive convention in [`MASTER_PLAN.md`](../MASTER_PLAN.md).

## What "Deep Research" is

Across ChatGPT (Deep Research, then folded into ChatGPT Agent),
Claude (Advanced Research), Gemini (Deep Research), and Perplexity
(Pro / Pages), the shape is the same: the user supplies a **research
goal** (not a single question), the agent autonomously runs a multi-step
loop — plan → search → read → take notes → identify gaps → search again
— for 5–30 minutes, and delivers a **structured cited document** rather
than a chat reply. The deliverable looks like a briefing or memo, not a
chat turn.

The distinguishing axis across products is the deliverable. Gemini can
render the report as an Audio Overview; Perplexity surfaces it as a
Pages-style publishable doc; ChatGPT embeds images / data viz; Claude
scopes Workspace + connectors as sources alongside the web. Humm's
differentiator is its existing **peer rich-text editor** (Plate.js) —
the natural home for a generated document is already in place.

## Why Humm is well-positioned

Five primitives Deep Research needs are already on `dev`:

| Need | Humm already has |
|---|---|
| Long-running multi-step execution | Task queue: HITL + chunking + Realtime tail ([#82](https://github.com/juchengquan/hummingbird/pull/82) / [#85](https://github.com/juchengquan/hummingbird/pull/85) / [#88](https://github.com/juchengquan/hummingbird/pull/88)) |
| Web sources | `webSearch` + `webFetch` skills (Exa, Brave, Tavily) |
| Document deliverable | Plate.js editor as a peer panel |
| Cited sources rendered inline | Sources rail + `[N]` clickable citation markers ([#33](https://github.com/juchengquan/hummingbird/pull/33)) |
| Workspace-grounded retrieval | `searchFiles` skill over per-conversation FTS + sectioned file FTS |
| Agent todo list | `setPlan` tool + `plan` events + Tasks panel render |

The combination is the moat: no OSS peer can ship Deep Research without
first building three of these surfaces.

## User flow sketch

```
/research "How are AI coding agents evaluated in 2026?"   (slash trigger)
        │  (or: workspace mode toggle + a regular task prompt)
        ▼
1.  Task strip opens — status: Queued → Planning
2.  Worker emits the plan (5–10 sub-questions as an outline)
        └─ phase 2+: optional HITL — user edits / reorders, then approves
3.  Worker iterates the plan
        └─ per sub-question: webSearch → webFetch top N → extract → write a note
        └─ Sources rail fills in live; task strip streams "Reading <title>..."
4.  Gap-finding pass — model identifies missing context, queues follow-up searches
5.  Synthesis pass — emits a structured Markdown report
6.  Report opens in the Editor panel as a workspace artifact
        └─ [N] citations clickable → flash the matching Sources rail card
        └─ User can edit, save, share, or re-run a "redo section" follow-up
```

All five "live" steps have existing UI carriers — Realtime tail for the
task strip, Sources rail for sources, Tasks panel for the plan list,
editor for the document.

## Design — composition, not new surface

Deep Research **is not a new task action** in the queue. It's a `mode`
flag persisted in the run's `RunCheckpoint.config`, with three thin
additions on top:

1. A `research`-mode system prompt that re-shapes how the agent uses
   the existing `setPlan` + `webSearch` + `webFetch` (+ optional
   `searchFiles`) tools.
2. A slash command `/research <goal>` that creates the task with
   `mode: 'research'`, auto-enables the search skills, and seeds the
   prompt.
3. A final "open in editor" hand-off — for Phase 1, a button on the
   settled task strip; for Phase 2+, an automatic hand-off into a
   workspace artifact.

Everything else — queue, chunking, HITL, Realtime tail, Sources rail,
citation rendering — is reused as-is.

### Concrete touchpoints

- **`lib/shared/api-schemas.ts`** — extend `TaskRequestSchema` with
  `mode: z.enum(['default', 'research']).optional().default('default')`.
- **`lib/server/agent/checkpoint.ts`** — add `mode?: 'default' | 'research'`
  to `RunCheckpoint['config']`. (Untouched runs default to `'default'`.)
- **`lib/server/agent/task-prompt.ts`** — `buildTaskSystemPrompt` takes
  the `mode`; when `'research'`, the system prompt is replaced (not
  appended) with the research-mode instructions.
- **`lib/server/agent/worker.ts`** — `runChunk` reads `checkpoint.config.mode`
  and passes it to `buildTaskSystemPrompt`. No dispatch changes.
- **`app/api/tasks/route.ts`** — pipes `body.mode` into the checkpoint
  config; defaults `mode='research'` runs to a higher `maxSteps`
  (35 vs. 25) since research runs are by nature long.
- **Slash command** — register `/research` in the existing slash
  surface; it sets `mode='research'`, force-enables `webSearch` +
  `webFetch`, optionally `searchFiles` for project-mode workspaces.
- **`components/agent/task-strip.tsx`** — on a settled `research`-mode
  task, add a single "Open in editor" button alongside the existing
  result actions. Phase 1: copies `finalText` into a new editor
  document. Phase 2+: deeper integration.

### The research-mode system prompt (sketch)

```
You are a research agent. Your job is to deliver a structured, cited
report — not a chat reply — on the following goal:

  <goal>

Workflow (use it strictly):

1. Plan. Call `setPlan` with 5–10 concrete sub-questions that, when
   answered, will fully address the goal. Each sub-question becomes
   one section of the final report.
2. Research. For each pending sub-question:
   a. Mark it in_progress in the plan.
   b. Use `webSearch` to find candidate sources (start broad).
   c. Use `webFetch` to read the top 2–4 most promising results.
   d. Write a short factual note (2–6 sentences) citing the
      source URLs as `[N]` markers.
   e. Mark it completed in the plan.
3. Gap pass. Re-read your notes. Identify any sub-question that's
   under-supported (only one source, contradictions, key claim
   unanchored). For each, run one targeted `webSearch` + `webFetch`
   to fill the gap.
4. Synthesize. Write the final report as Markdown with:
   - A short executive summary (3–5 sentences).
   - One `##` section per sub-question, in plan order.
   - Inline `[N]` markers tying every non-trivial claim to a source.
   - A `## Sources` list at the end with `[N] Title — URL`.

Constraints:
- Do not pad. If a sub-question turned out to be empty, say so and move on.
- Prefer recent (≤ 24 months) sources except for definitional context.
- Do not editorialize beyond what your sources support.
- Stop when the Markdown report is written. Do not ask the user
  questions in default mode; raise an `askUser` only when a
  sub-question cannot be answered without a real-world choice from
  the user.
```

The existing default system prompt is replaced wholesale in
`research` mode — appending would invite the model to drift between
the two roles.

### Plan event reuse

The agent already declares its plan via `setPlan`, which emits a
`PlanEvent` ([`lib/shared/agent/events.ts`](../lib/shared/agent/events.ts)).
The Tasks panel already renders it as a live todo list. For research
mode, the plan items are the sub-question outline — no new event kind,
no new UI.

Phase 2 adds **plan HITL**: after the very first `setPlan` call in
research mode, the worker injects an automatic `askUser` (kind:
`'input'`) prompting the user to confirm or edit the outline before
proceeding. Already supported by the input-policy machinery; just one
new conditional in the runner.

### Final hand-off into the editor

The task's terminal event already carries `finalText` (see
`ResultEvent`). Phase 1: on a settled research task, the task strip
shows an "Open in editor" button; clicking it calls
`setWorkspaceDocument` (existing store mutator) with the Markdown
parsed into Plate AST.

Phase 2 escalates: the worker emits an `artifact_ref` event
(`kind: 'document'`) for the final report, written via the existing
artifact pipeline. The editor opens it automatically when the task
settles. No PR-button click.

## Migration / phasing

### Phase 1 — Basic loop (one PR, ~300–400 lines)

- `TaskRequestSchema` adds `mode` (default / research).
- `RunCheckpoint.config` carries `mode`.
- `buildTaskSystemPrompt` returns the research prompt when `mode='research'`.
- `/research <goal>` slash command opens the task with `mode='research'`,
  `maxSteps=35`, search skills force-enabled.
- Task-strip "Open in editor" button on settled research tasks.
- No HITL on plan, no workspace files, no automatic editor hand-off.
- No DB migration — `mode` lives only in the checkpoint JSON.

Acceptance:
- `/research "Summarize state of OSS agent frameworks in 2026"` produces
  a settled task with a plan list, Sources rail filled, and a Markdown
  report that opens in the editor when clicked.

### Phase 2 — Plan HITL + automatic editor hand-off (~250 lines)

- On the first `setPlan` call in research mode, the runner injects an
  `askUser` (`input` kind) showing the outline and asking
  "Approve / edit before research starts?". Default: auto-approve after
  10 s (configurable per-workspace toggle).
- Worker emits an `artifact_ref` event with the final Markdown after
  synthesis. The settled task auto-opens the artifact in the editor.
- Persist the research plan + per-section notes as a research artifact
  (jsonb), enabling "redo section N" follow-ups (Phase 4).

### Phase 3 — Workspace-knowledge sources (~150 lines)

- Auto-enable `searchFiles` when the run's workspace has files,
  alongside the web skills.
- Update the research prompt to instruct the agent to consult
  `searchFiles` before falling back to web for workspace-anchored
  sub-questions ("Compare this file to industry practice", etc.).
- Sources rail handles file results — already shipped.
- Surface a per-task toggle: "include workspace files".

### Phase 4 — Polish (~300 lines)

- Parallel section research via subagents (composes with
  [`SURVEY-market-2026.md` §4.5](../SURVEY-market-2026.md) if subagents
  ship first).
- Structured citation formatter (canonical `[N]` ordering across
  sections, deduped Sources block).
- Inline chart / image embeds — Mermaid / TSX artifacts inline in
  the report.
- "Redo section" affordance on the editor view of the report — surfaces
  a per-section refresh that re-runs steps 2 + 3 for that sub-question
  only, using the persisted plan from Phase 2.

## Trade-offs / open questions

- **Token budget.** A 5–30 min run is expensive. Phase 1 adds no
  per-research budget cap; the existing `maxSteps` (35 in research
  mode) acts as a coarse upper bound. Phase 4 should add a
  `maxSourcesPerSection` ceiling and a graceful "summarize-what-we-have"
  fallback if `maxSteps` is hit before synthesis.
- **Plan HITL default.** Phase 2's "approve plan" prompt is value-add
  for serious research but friction on quick prompts. Default: off,
  with a workspace setting to flip it on. Auto-approve timeout
  (10 s) is a compromise.
- **Sources channel.** Phase 1 is web-only; Phase 3 adds workspace
  files. Open: do we ever auto-discover URL bookmarks as candidate
  sources too? Probably yes in Phase 3 (composes with
  `url_bookmarks` table).
- **Image / chart embeds.** Phase 1 is text + citations only. Phase 4
  adds Mermaid diagrams + TSX charts via the existing sandboxed
  artifacts pipeline. Open: should the agent be told to draw a chart
  when sources include numeric data, or only on explicit request?
- **Cancellation.** Already covered by the queue's `runStatus:
  'cancelled'` — no new work.
- **Reproducibility / "redo section".** Phase 2 persists the plan +
  notes as a research artifact; Phase 4 exposes per-section re-run.
- **Output format alternatives** (Audio Overview, slide deck,
  presentation) — out of scope for this plan; tracked under
  [`SURVEY-market-2026.md` §4.2](../SURVEY-market-2026.md).
- **Concurrency safety.** Two `/research` runs on the same workspace
  shouldn't collide. Already handled — each task gets its own runId
  and event log.

## Relationship to other plans

- **`PLAN-agent-task-queue.md`** — the substrate. Deep Research is a
  consumer of the queue, not a modification.
- **`PLAN-agent-hitl-approvals.md`** — Phase 2 plan-HITL reuses the
  `askUser` machinery (`input` kind) from this plan.
- **`PLAN-cross-conversation-memory.md`** — Phase 3+ could plug
  retrieved memories in as a third source channel alongside web +
  files; doc the integration when that plan ships.
- **`SURVEY-market-2026.md` §4.1** — origin; this plan replaces that
  one-paragraph entry.

## Recommendation / next step

Ship **Phase 1** as the first PR. It validates the composition end-to-end
on the smallest possible surface (no new DB tables, no new events, no
HITL plumbing) and yields a usable feature: `/research "<goal>"` →
working settled report. Once that's on `dev`, Phase 2 (plan HITL +
artifact hand-off) is the natural follow-on — it's the smallest delta
that turns "click to open" into "opens automatically", which is what
makes the feature feel finished.

Phase 3 and Phase 4 are optional follow-ons and can be re-prioritised
against the rest of the [`SURVEY-market-2026.md` §6 slate](../SURVEY-market-2026.md)
when the time comes.
