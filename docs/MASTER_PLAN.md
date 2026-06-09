# Master plan

Single source of truth for what's shipped, what's next, and what's a
parking-lot idea — plus the conventions for keeping this file honest.

> This file replaces the earlier split between `ROADMAP.md` (shipped +
> planned tables) and `BACKLOG.md` (loose ideas). Per-feature detail
> still lives in `PLAN-*.md` — active plans in `docs/`, archived plans
> in [`docs/_done/`](_done/).

Last updated: **2026-06-09** — see [Recent activity](#recent-activity)
just below for the rolling pulse, and the
[Shipped log](#shipped-log-newest-first) further down for the full
chronological record. The 2026-06-09 pass was a **market refresh**:
five new distinctive ideas added below, and three previously-planned
items (Langfuse, Aider editor pair, accurate token counting)
deprioritised into [Parked / low priority](#parked--low-priority).

---

## Status snapshot

- **22 active plans** in `docs/` (planning / phased) — including the
  **15 new plans** from the 2026-06-09 market refresh: round 1 (MCP
  Apps, code interpreter, generative UI parts, portable skills, subagent
  orchestration) + round 2 (A2A interop, `browse` skill, semantic
  caching, prompt optimisation, collaborative editing) + round 3 (inline
  autocomplete, reasoning-effort control, structured outputs, guardrails
  + PII, ambient agents). See
  [Next — planned work](#next--planned-work-have-a-plan) for the row
  table.
- **3 parked / low-priority** plans (Langfuse, Aider editor pair,
  typed prompt variables) + accurate token counting. See
  [Parked / low priority](#parked--low-priority).
- **30 fully-shipped plans archived** under [`docs/_done/`](_done/).
- **Nothing currently in flight** (no branch with active work that
  doesn't already have a PR).
- **Latest ships** (last session, in chronological order): #165 → #166
  → #167 → #168 → #169, plus the docs landings #170 (cross-product
  plan refresh) and #171 (third-backend naming). Detail in
  [Recent activity](#recent-activity).

## Status legend

- ✅ **Shipped** — merged to `dev`, live in the app.
- 🚧 **In progress** — branch exists, work underway.
- 📐 **Planned** — `PLAN-*.md` exists, no code yet.
- 💡 **Backlog** — open idea, no plan yet. See
  [Later — distinctive ideas](#later--distinctive-ideas-no-plan-yet).
- 🪜 **Phased** — partial ship; sub-phases tracked inside the plan.
- ⏸ **Deferred** — `PLAN-*.md` exists; explicit decision not to build
  until evidence demands it (e.g. real user requests).

---

## Now — actively in progress

| Plan | Branch | Notes |
|---|---|---|
| _(nothing actively in flight)_ | | |

---

## Next — planned work (have a `PLAN-*.md`)

The 🪜 rows are partial ships — their finished phases are documented
inside the plan; only the listed phase(s) remain. The entire
long-running agent-tasks stack (event-model, runner, route, resume,
hybrid UI, HITL approvals, **and the queue-backed continuation incl.
scheduling**) is shipped — its plans live in
[`_done/`](_done/).

| Plan | Status | Sketch |
|---|---|---|
| 🪜 [Cross-product inspirations menu](PLAN-cross-product-inspirations.md) | 7 of 14 shipped, 1 closed | A menu, not a single feature — 14 items synthesised from a five-cohort survey of OSS + commercial AI/chat/agent products. **Shipped:** #1 conversation system prompt (#165), #2 Ollama + #3 OpenRouter + #5 Library (#167), #4 Part 2 gateway tagging (#166), #6 `#`-mention + RAG toggle (#168, #169), #7 Flowchat canvas. **Closed:** #4 Part 1 (caching — won't do without a Vercel-gateway commitment). **Open:** #8 Beam, #9 Elicit tables, #10 Langfuse, #11 Aider editor pair, #12 hybrid search, #13 Letta memory, #14 LangGraph checkpointer. Per-item status + a Shipped tracker live in the plan |
| 🪜 [Agent API as a separate service](PLAN-agent-api.md) | Phases 0 through 4-4b shipped; one follow-up open | All six phases of the original plan plus seven of the open follow-ups have shipped: `services/agent-py/` runs end-to-end (chat + tools + MCP + url-fetch + summarize + refresh-url + extract + whoami + health); per-IP rate buckets + idle watchdog (PR #161); `POST /v1/mcp/server` CRUD (#160); provider-categorised errors (#155); frontend selector for non-chat endpoints (#156); `workspace_id` + per-skill config on `/v1/chat` (#145); `useChat()` adoption (#148–#154). **One open item:** real DNS-rebinding test against actual DNS for the MCP-proxy SSRF guard (currently mocked). Phases 5 (default-on + decommission) and 6 (tidy + archive) explicitly deferred — per project policy both Python and TS stacks stay live and the user picks backend per-account via the Phase 4-2 selector |
| 🪜 [Small follow-ups batch](PLAN-small-followups.md) | 4 done, 1 moot, 2 open | Done: generatedImages sync (#45), recap-of-recaps (#63), roadmap sweep, signed-URL re-sign. Moot: local-mode MCP creds for tasks (rejected up front by #85). Open: per-tool server-side approval flags, task-route integration tests. (Accurate token counting moved to [Parked / low priority](#parked--low-priority) in the 2026-06-09 refresh.) |
| 📐 [MCP Apps — interactive UI in chat](PLAN-mcp-apps.md) | planning (new 2026-06-09) | Render an MCP tool's `ui://` resource in the existing live-artifact sandbox iframe + a `postMessage` tool-call bridge back to the same MCP server. Composes the sandbox renderer (#36) with the MCP integration. M, 3 commits |
| 📐 [Sandboxed code interpreter](PLAN-code-interpreter.md) | planning (new 2026-06-09) | A `runCode` server skill backed by an E2B-style sandbox (self-hostable behind an adapter). Charts reuse the `generateImage` Storage + gallery path; stdout/tables ride a new `data-code-result` part. Budget-gated or HITL-gated. L, PR series |
| 📐 [Generative UI parts](PLAN-generative-ui-parts.md) | planning (new 2026-06-09) | A `renderUI` tool emits typed, allow-listed `data-ui` parts (choice / confirm / info-table / mini-form) rendered as real React components. The chat-turn twin of `askUser`; the in-process twin of MCP Apps. M, 3 commits |
| 📐 [Portable Agent Skills (SKILL.md)](PLAN-portable-skills.md) | planning (new 2026-06-09) | A third skill kind that's data, not code: `SKILL.md` front-matter + body, stored in a new `userSkills` slice, imported by URL (mirrors persona share #110), listed in the Library tab. Progressive disclosure via prompt injection. S–M, 3 commits |
| 📐 [Subagent orchestration](PLAN-subagent-orchestration.md) | planning (new 2026-06-09) | One goal → N specialist subagents (each a persona-pinned child task) run in parallel via the existing executor + a durable join barrier; results aggregate back to the orchestrator. Depth cap 1, breadth cap 5. Distinct from Beam (#8). L, PR series |
| 📐 [A2A interoperability](PLAN-a2a-interop.md) | planning (new 2026-06-09 r2) | Expose personas as A2A agent cards + delegate to remote A2A agents; complement to MCP. A2A task lifecycle maps 1:1 onto the existing RunStatus + HITL suspend. Outbound first (lower risk), inbound server second. Publishing gated on multi-tenant. L, PR series |
| 📐 [Browser / `browse` skill](PLAN-browser-use.md) | planning (new 2026-06-09 r2) | A `runBrowserTask` server skill (browser-use, in agent-py) for navigate/extract/form-fill; screenshots reuse the `data-tool-image` gallery; mutating actions HITL-gated; auth flows last + heavily gated. Reuses the code-interpreter security model. L, PR series |
| 📐 [Semantic caching](PLAN-semantic-caching.md) | planning (new 2026-06-09 r2) | Cache the deterministic non-chat calls (summarize / suggestions / extract). Phase 1 = exact-key cache (no embeddings); Phase 2 = embedding-similarity once the pipeline lands. Distinct from the closed gateway-caching item; never caches the chat stream. M, phased |
| 📐 [Prompt optimisation (GEPA/DSPy)](PLAN-prompt-optimization.md) | planning (new 2026-06-09 r2) | Offline/admin loop that evolves skill / persona / editor prompts from a labelled eval set + traces. First target: the `getChooseToolPrompt` classifier (measurable). Human-accepted, versioned, never auto-deployed. Gated on an eval set. M–L |
| 📐 [Collaborative editing + AI peer](PLAN-collab-editing.md) | planning (new 2026-06-09 r2) | Yjs CRDT + presence in the Plate editor with the AI as a server-side Yjs peer (visible cursor + status). Phase A (AI-as-peer) has single-user value; Phase B (human multiplayer) gated on the document-sharing / multi-tenant story. L |
| 📐 [Inline editor autocomplete](PLAN-inline-autocomplete.md) | planning (new 2026-06-09 r3) | Copilot-style ghost text in the Plate editor. Plate's `CopilotKit` is *already installed* — the work is a fast-model completion endpoint + tuning + a toggle. Off by default. S–M, 2 commits |
| 📐 [Reasoning-effort control](PLAN-reasoning-effort-control.md) | planning (new 2026-06-09 r3) | A Fast/Balanced/Thorough dial beside the model picker mapping to the provider's reasoning budget (`providerOptions`). No-op + hidden for non-reasoning models. Mostly-existing plumbing. S–M, 2 commits |
| 📐 [Structured outputs](PLAN-structured-outputs.md) | planning (new 2026-06-09 r3) | Replace best-effort `parseSuggestionsJson` with native constrained-decoding `generateObject` on the deterministic calls (suggestions / summarize / extract / comment / table), capability-gated, lenient parser as fallback. M, 3 commits |
| 📐 [Guardrails + PII redaction](PLAN-guardrails-pii.md) | planning (new 2026-06-09 r3) | Optional, off-by-default pre/post hooks: PII redaction (Presidio-class) + content moderation, per-workspace policy, self-hostable behind an adapter. Mostly relevant once multi-user. M, PR series |
| 📐 [Proactive / ambient agents](PLAN-ambient-agents.md) | planning (new 2026-06-09 r3) | Extend the existing `task_schedules` cron dispatch into an *event* dispatcher: "when X happens (file/bookmark/note added, task finished), run persona Y." Hard loop guards + HITL-by-default for side-effecting triggers. M–L, PR series |
| 📐 [Local Supabase switch](PLAN-local-supabase-switch.md) | planning | Move local dev off the hosted Supabase project onto a `bun run supabase:start` stack on this machine. 5 steps, ~30 min wall-clock. 13 open questions to walk through before execution (cloud data handling, Path A vs Path B, auth-free local mode, etc.) |
| 📐 [Cross-conversation memory with retrieval](PLAN-cross-conversation-memory.md) | planning | pgvector + `memoryRecall` skill |
| 📐 [Local RAG vector store](PLAN-local-rag.md) | decision doc | Where embeddings live — Supabase pgvector / self-host Postgres / in-browser PGlite. No driver chosen |
| 📐 [Replace Supabase with self-hosted Postgres](PLAN-replace-supabase-with-postgres.md) | planning | Infrastructure migration — 5 phases, ~2 weeks total. Separate from `PLAN-local-supabase-switch.md`, which keeps Supabase but moves it onto your machine |
| 🪜 [Backend extraction](PLAN-backend-extraction.md) | Phase 2 satisfied by agent-api | Phase 1 (contract-first frontend ⇄ API surface) shipped; Phase 2 (stand up a Python backend) satisfied by PLAN-agent-api `services/agent-py/`. The plan stays in `docs/` for the contract narrative but has no open work |

---

## Parked / low priority

Plans that exist (or are well-scoped) but are **deliberately not
scheduled** right now. Each has a re-open trigger. These are not
abandoned — the `PLAN-*.md` files stay in `docs/`; they're just below
the line for the current work focus.

| Plan | Status | Why parked / re-open trigger |
|---|---|---|
| ⏸ [Langfuse self-hosted observability](PLAN-langfuse-observability.md) | deferred (was 📐 planning) | Deprioritised in the 2026-06-09 refresh. A trace/cost dashboard only earns its keep once someone commits to writing + acting on evals (see open question #2 in the inspirations plan); until then the per-workspace cost cut from the shipped Gateway tagging (#166) covers the 80% case. **Re-open when:** a model swap or cost regression actually needs distributed-trace debugging, or eval-writing capacity is allocated. Inspirations item #10 |
| ⏸ [Aider architect/editor pair](PLAN-aider-architect-editor.md) | deferred (was 📐 planning) | Deprioritised in the 2026-06-09 refresh. The single-call Plate edit path + the shipped diff-review surface (#49) work today; the two-call planner/editor split is a quality optimisation, not a gap. **Re-open when:** structured-patch edit quality becomes a measured pain point, or the new [code interpreter](PLAN-code-interpreter.md) work makes a fast-model patch loop cheap to reuse. Inspirations item #11 |
| ⏸ Accurate per-family token counting | low priority (Item 2 of [small-followups](PLAN-small-followups.md)) | Deprioritised in the 2026-06-09 refresh. The chars/4 heuristic undercounts code/JSON chats 1.5–2×, but the context meter is a "you might be close" cue, not a billing surface; `js-tiktoken` is ~600 KB gzipped. **Re-open when:** the meter graduates into a hard budget/quota gate, or per-family pricing surfaces in the UI |
| ⏸ [Typed prompt variables](PLAN-typed-prompt-variables.md) | deferred (long-standing) | Workspace-scoping migration shipped (`9b3c84f`); the typing UI itself remains deliberately deferred — "do not build unless users explicitly ask" |

---

## Later — distinctive ideas (no plan yet)

Distinctive feature ideas — not yet planned, not yet started, not just
catch-up with other AI chat apps. Each entry has rough effort, what
makes it distinctive, and pointers to existing surfaces it would build
on. Promote to **Next** when an item earns its own `PLAN-*.md`.

### Diff mode for documents

**Why distinctive.** Editor docs are workspace-scoped. When AI suggests
changes via the Editor, today they're applied in place. A diff mode
would show before/after with accept/reject per chunk — like
GitHub's PR review for chat-driven writing.

**Sketch.** When an AI command modifies the editor doc, snapshot the
pre-change content; render the post-change content with a side-by-side
or inline diff (`diff-match-patch`) and Accept / Reject buttons per
hunk. Accepted hunks merge into the doc; rejected ones revert.

**Builds on.** Editor (Plate.js), `setWorkspaceDocument`, the
existing AI command routes (`/api/ai/command`).

**Effort.** Medium (~300–400 lines). `diff-match-patch` is small.

> **Note.** A different "diff mode" — the AI-command-review toggle in
> the editor — already shipped via
> [PLAN-editor-diff-mode.md](_done/PLAN-editor-diff-mode.md) (#49). The
> idea above is the *broader* per-document-change variant; the shipped
> one is the per-AI-command-only variant.

> **Accurate per-family token counting** moved to
> [Parked / low priority](#parked--low-priority) in the 2026-06-09
> refresh — see Item 2 of
> [PLAN-small-followups.md](PLAN-small-followups.md) for the detail.

> **The five ideas surfaced in the 2026-06-09 market refresh now have
> dedicated plans and have been promoted to
> [Next — planned work](#next--planned-work-have-a-plan):**
> [MCP Apps](PLAN-mcp-apps.md) · [Sandboxed code interpreter](PLAN-code-interpreter.md)
> · [Generative UI parts](PLAN-generative-ui-parts.md) ·
> [Portable Agent Skills](PLAN-portable-skills.md) ·
> [Subagent orchestration](PLAN-subagent-orchestration.md). Each was
> chosen for composing with surfaces Hummingbird already has, not
> because a competitor shipped it.

> **The five ideas from the second research round (2026-06-09) now have
> dedicated plans and have been promoted to
> [Next — planned work](#next--planned-work-have-a-plan):**
> [A2A interoperability](PLAN-a2a-interop.md) ·
> [Browser / `browse` skill](PLAN-browser-use.md) ·
> [Semantic caching](PLAN-semantic-caching.md) ·
> [Prompt optimisation (GEPA/DSPy)](PLAN-prompt-optimization.md) ·
> [Collaborative editing + AI peer](PLAN-collab-editing.md).

> **Two adjacent findings folded into existing plans rather than added
> as standalone ideas:** **GraphRAG / hybrid graph+vector retrieval**
> (2026 consensus is hybrid — vectors for breadth, graph for multi-hop
> depth; LazyGraphRAG cuts the prohibitive indexing cost) strengthens
> the *depth* layer of [PLAN-local-rag.md](PLAN-local-rag.md) +
> [PLAN-cross-conversation-memory.md](PLAN-cross-conversation-memory.md)
> rather than standing alone. **Fully-local in-browser inference**
> (PGlite + transformers.js + WebGPU/WebLLM, viable to ~10k chunks)
> strengthens the in-browser-PGlite option already weighed in
> `PLAN-local-rag.md`.

> **The five ideas from the third research round (2026-06-09) now have
> dedicated plans and have been promoted to
> [Next — planned work](#next--planned-work-have-a-plan):**
> [Inline editor autocomplete](PLAN-inline-autocomplete.md) ·
> [Reasoning-effort control](PLAN-reasoning-effort-control.md) ·
> [Structured outputs](PLAN-structured-outputs.md) ·
> [Guardrails + PII redaction](PLAN-guardrails-pii.md) ·
> [Proactive / ambient agents](PLAN-ambient-agents.md).

### Fourth research round (2026-06-09)

A fourth sweep across angles the first three rounds didn't cover — voice
output, model economics, answer trust, visual composition, and richer
document understanding. Idea-level for now; promote to a `PLAN-*.md`
when one earns a slot.

#### Read-aloud / TTS voice output

**Why distinctive.** The voice bar in 2026 is streaming TTS —
Chatterbox-Turbo (sub-200 ms), MeloTTS, Hume TADA (~11× realtime), all
open-source / self-hostable. Hummingbird tracks "voice input (Whisper)"
as a catch-up note, but voice *out* — read the assistant's reply aloud,
hands-free — is a distinctive, low-risk add and the foundation for a
full voice mode.

**Sketch.** A read-aloud control on assistant messages backed by a
streaming TTS adapter (Chatterbox / MeloTTS self-host behind a base-URL
adapter — the Minimax/E2B pattern; or a hosted voice). Stream audio as
the text streams; voice picker + per-workspace default.

**Builds on.** Chat message renderer, the model-provider adapter
pattern, the catch-up voice-input path it pairs with.

**Effort.** Medium.
**Source.** [Open-source TTS 2026](https://www.bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models) · [Chatterbox](https://www.resemble.ai/learn/models/chatterbox)

#### Smart model routing (RouteLLM-style)

**Why distinctive.** RouteLLM (ICLR 2025, open-source) reaches ~95% of
strong-model quality at ~14–26% strong-model calls — a 75–85% cost cut —
by routing each prompt to the cheapest *capable* model via a complexity
classifier. Hummingbird already has `openrouter/auto` (routes *within*
OpenRouter); this is a Hummingbird-level `model: "auto"` that routes
across the *whole* provider set (Anthropic / gateway / Ollama /
OpenRouter) by query complexity.

**Sketch.** A complexity classifier (a small model, or RouteLLM's
matrix-factorisation router) picks strong vs weak per turn from a
configured pair/set; a new `auto` option in the model picker. A cascade
mode (try weak, escalate on low confidence) comes later.

**Builds on.** `model-provider.ts`, `config/models.json`, the model
picker, `openrouter/auto` (precedent).

**Effort.** Medium.
**Source.** [RouteLLM](https://routellm.dev/) · [LLM model routing guide 2026](https://www.burnwise.io/blog/llm-model-routing-guide)

#### Citation & verifiability layer

**Why distinctive.** Citation-hallucination rates run 14–95% across
vendors; the 2026 fix is a *verification* layer — ground each claim
against retrieved sources + flag unsupported statements with a
confidence signal. Hummingbird already renders inline citations from web
search; extending to a claim-level verify pass (against web-search +
`searchFiles` results) turns citations from decorative to *checked*.

**Sketch.** A post-turn verifier (chain-of-verification / retrieval-
grounded check) that maps assistant claims to cited sources, flags
unsupported ones inline, and surfaces a confidence affordance. Opt-in
(adds a verification call); strongest in Deep Research mode.

**Builds on.** Web search + `searchFiles` retrieval, inline-citation
rendering, Deep Research mode, the message renderer.

**Effort.** Medium–large.
**Source.** [CiteCheck — retrieval-grounded citation verification](https://arxiv.org/html/2605.27700v1) · [preventing LLM hallucinations 2026](https://keymakr.com/blog/preventing-llm-hallucinations-techniques-best-practices-2026/)

#### Visual workflow / flow builder on the canvas

**Why distinctive.** Langflow / Flowise / OpenAI Agent Builder made
drag-drop node graphs the standard way to compose agent workflows.
Hummingbird already has a react-flow workspace canvas + skills +
personas + the task executor (+ planned subagents) — so a flow builder
is *composition* of surfaces it already owns: drag skills/personas onto
the canvas, wire typed edges, save as a reusable workflow that runs on
the executor.

**Sketch.** A "workflow" canvas mode with node kinds for skill /
persona / input / branch; typed edges (output schema → next input); a
compiler that lowers the graph onto the task executor (each node a step
or subagent). Reuses the canvas + RunStore.

**Builds on.** Workspace canvas (react-flow), skills registry, personas,
subagent orchestration (planned), task executor.

**Effort.** Large.
**Source.** [Langflow](https://medium.com/@mridulv204/langflow-no-code-ai-workflow-builder-3b0fd8b0a977) · [no-code AI agent builders 2026](https://metaflow.life/blog/best-no-code-ai-agent-builders)

#### Multimodal document understanding

**Why distinctive.** Hummingbird's extraction is text-only
(`lib/server/extraction.ts` → pdf-parse / mammoth / xlsx), which drops
tables, charts, figures, and layout — often where the answer lives. 2026
VLMs (GLM-4.5V, Qwen2.5-VL, vision-guided chunking) parse documents
*visually*, preserving structure. Vision-aware extraction would
materially improve `searchFiles` retrieval quality + file Q&A.

**Sketch.** A vision-extraction path: render PDF pages to images, run a
vision-capable model (Hummingbird already supports vision input) for
layout-aware structured extraction (tables → markdown, figures →
captions), feed the richer chunks into the existing FTS / `searchFiles`
index. Gated to vision-capable models + larger files where it pays.

**Builds on.** `/api/extract` + `lib/server/extraction.ts`,
vision-capable models, file full-text / `searchFiles`.

**Effort.** Medium–large.
**Source.** [Best multimodal models for document analysis 2026](https://www.siliconflow.com/articles/en/best-multimodal-models-for-document-analysis) · [vision-guided chunking for RAG](https://arxiv.org/pdf/2506.16035)

---

## Catch-up watch

Catch-up features that are table stakes for AI chat apps in 2026 —
worth shipping eventually but not "distinctive." Tracked informally —
pick them up if a user explicitly asks or a particular need arises.

- Voice — bar has moved from dictation (Whisper) to **realtime
  speech-to-speech**; for a local-first build, streaming STT
  (Parakeet/Voxtral/Whisper) into the existing chat path is the
  pragmatic first step, full duplex later
- Browser extension
- Quick actions on selected text
- Side-by-side model comparison
- Mobile PWA install + offline drafting
- Weekly digest emails
- Cross-conversation lexical search beyond the existing `⌘K` palette
  (covered partially today; full version is gated on the
  cross-conversation-memory plan above)
- **MCP spec 2026 readiness** — the 2026-07-28 spec RC lands a
  stateless core, the Extensions framework, Tasks, full JSON-Schema
  tool support, and auth hardening. Hummingbird carries a heavy MCP
  integration (cloud + local creds, proxy, CRUD), so this is a
  keep-current maintenance watch, not a feature.
  [Source](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- Image generation — already shipped (#24, #26, #27, #29) — kept here
  as a reminder that "table-stakes" lines move; once shipped the row
  graduates to the Shipped log

---

## Recent activity

Rolling pulse — latest first. The full chronological record lives in
the [Shipped log](#shipped-log-newest-first) further down.

**This session (2026-06-09) — market refresh + 5 new plans (docs
only, no code):** A fresh sweep of the 2026 AI-chat / agent landscape
(MCP spec evolution + MCP Apps, Anthropic Agent Skills, the self-host
chat cohort, the multi-agent-orchestration wave). Wrote **five
dedicated plans** and promoted them to
[Next — planned work](#next--planned-work-have-a-plan), each grounded
in a codebase survey of the surfaces it builds on:
[MCP Apps](PLAN-mcp-apps.md) (interactive server-driven UI in chat),
[Sandboxed code interpreter](PLAN-code-interpreter.md),
[Generative UI parts](PLAN-generative-ui-parts.md),
[Portable Agent Skills (SKILL.md)](PLAN-portable-skills.md), and
[Subagent orchestration](PLAN-subagent-orchestration.md). Added an
**MCP-spec-2026-readiness** watch item. **Deprioritised three**
previously-planned items into the new
[Parked / low priority](#parked--low-priority) section: Langfuse
observability, the Aider editor pair, and accurate token counting —
each with a documented re-open trigger. No source files changed.

A **second research round** (same day) covered angles the first round
didn't — A2A agent interoperability, browser/computer use as a `browse`
skill, automatic prompt optimisation (GEPA/DSPy), semantic caching for
deterministic calls, and real-time collaborative editing with the AI as
a CRDT peer. All five were then **written up as dedicated plans and
promoted to Next** (grounded in a third codebase survey — which
confirmed there's no embedding pipeline yet, and that Plate already
bundles CopilotKit + CursorOverlayKit but no Yjs, both reflected in the
plans). Two findings (GraphRAG, fully-local in-browser inference) were
folded into the existing retrieval plans rather than added standalone.

A **third research round** covered inline editor ghost-text
autocomplete, reasoning-effort control, structured outputs / constrained
decoding, optional guardrails + PII redaction, and proactive / ambient
event-triggered agents — all five then **written up as dedicated plans
and promoted to Next**.

A **fourth research round** added five more idea-level candidates to
[Later](#later--distinctive-ideas-no-plan-yet) — read-aloud / TTS voice
output, smart model routing (RouteLLM-style), a citation & verifiability
layer, a visual workflow / flow builder on the canvas, and multimodal
(vision-aware) document understanding.

**Previous session (2026-06-06):** Cross-product-inspirations drawdown —
six of the fourteen menu items shipped this session:

- **Per-attached-file inline ↔ RAG retrieval toggle** (#169 — item #6
  second half; `Conversation.fileRetrievalModes`, server suppresses
  the inlined body for rag-mode files + auto-enables `searchFiles`,
  search icon toggle in the ContextPicker).
- **`#`-mention for files + bookmarks** (#168 — item #6 first half;
  third autocomplete sibling beside `/` and `@`).
- **Ollama + OpenRouter providers + Library tab** (#167 — items #2,
  #3, #5 in one PR: `ollama/*` via `allowInsecureBaseUrl`,
  `openrouter/auto`, cross-conversation index of generated images +
  artifacts).
- **Vercel AI Gateway per-workspace tagging** (#166 — item #4 Part 2;
  `providerOptions.gateway.tags`, Part 1 caching deferred to a
  verification ticket).
- **Conversation-level system prompt** (#165 — item #1;
  `Conversation.systemPrompt`, persona-additive 3-tier composer,
  "Thread instructions" dialog).

Plus the docs landings #170 (cross-product plan refresh) and #171
(third-backend naming), and the smaller follow-ups that closed out
inspirations item #3's residual scope: **OpenRouter per-route
fallback list** — each non-`auto` OpenRouter entry in
`config/models.json` declares a `fallbacks: [...]` array of upstream
ids; the openai-compatible provider's `transformRequestBody` hook
reads this at boot into a `Map<upstreamId, fallbacks[]>` and injects
`body.models = [...]` on outbound requests. OpenRouter then retries
each fallback in order when the primary is overloaded — visible
reliability win without touching call sites.

**Previous session:** Per-IP rate buckets + idle watchdog on `/v1/chat`
closed the second-to-last open item in PLAN-agent-api; only the real
DNS-rebinding test remains. Before that: MCP server CRUD endpoint
(#160), frontend perf pass (#159), code quality pass (#158), chat path
+ agent-py routers + store cascades refactor (#157), backend selector
for the four non-chat endpoints (#156), provider-categorised errors on
`/v1/chat` (#155). And before that: `useChat()` adoption track
(PRs #148–#154) which retired the legacy custom SSE format across all
three backends; PLAN-agent-api Phases 2b–4-4b (PRs #142–#147).

**Plan-state changes (2026-06-06):** Four plans archived into
[`_done/`](_done/) after verification of full implementation:
PLAN-agent-ts-followups, PLAN-conversation-system-prompt,
PLAN-useChat-adoption, PLAN-agent-ts. A fifth plan,
PLAN-gateway-caching-and-workspace-tagging, was archived after
shipping Part 2 (tagging) and **closing Part 1 (caching) as
won't-do** — the file now carries a per-provider triage table
explaining when the work would earn its keep, so a future reopen
has a clean starting point.

---

## Shipped log (newest first)

Each row links to the plan if there is one, or to a representative PR
otherwise. Plans archived into [`_done/`](_done/) link there;
still-open phased plans link in-place.

| When | Feature | Where |
|---|---|---|
| 2026-06-06 | **Per-attached-file inline ↔ RAG retrieval toggle** — second half of inspirations item #6. New `Conversation.fileRetrievalModes` (`Record<fileId, "rag">`, default absent = inline). When a file is flipped to rag the send path drops its `text` from the wire summary + stamps `retrievalMode: "rag"`; the server renderer suppresses the inlined body (rendering a "call `searchFiles`" stub instead) and excludes it from the meta-only footer; the chat route auto-enables `searchFiles` so the file stays reachable. UI: a `<Search>` toggle on each non-image attached-file row in the ContextPicker (highlighted on rag). Migration `0022_conversation_file_retrieval_modes` (+ jsonb-object CHECK), `STORE_VERSION 22→23`, full sync round-trip. Item #6 (RAG half) from PLAN-cross-product-inspirations | [PLAN](PLAN-cross-product-inspirations.md) · [#169](https://github.com/juchengquan/hummingbird/pull/169) |
| 2026-06-06 | **`#`-mention for files + bookmarks** — first half of inspirations item #6. Third autocomplete sibling beside `/` (skills) and `@` (prompts): `useAttachmentMentionAutocomplete` + a pure `lib/shared/attachment-mentions/parser.ts` (leading-`#`-only trigger, name-prefix > name-substring ranking, bookmarks add a URL-substring fallback tier, fixed workspace-files → private-files → bookmarks kind ordering). Picking attaches the source to the conversation via the existing toggle mutators and strips the `#token`. Reuses the symbol-agnostic `SlashAutocomplete` menu with per-kind `groupLabel`. Notes punted (no conversation-attachment mechanism today). Item #6 (mention half) from PLAN-cross-product-inspirations | [PLAN](PLAN-cross-product-inspirations.md) · [#168](https://github.com/juchengquan/hummingbird/pull/168) |
| 2026-06-06 | **Ollama + OpenRouter providers + Library tab** — three S-sized inspirations items in one PR. **#2 Ollama:** `ollama/*` model ids route through `createOpenAICompatible`; new `allowInsecureBaseUrl: true` provider flag relaxes the SSRF gate (allows `http://localhost`/loopback/private hosts) + makes the API key optional, with a split-out `isParseableHttpUrl` guard so malformed URLs still fail at boot. **#3 OpenRouter:** `openrouter/*` against the fixed `https://openrouter.ai/api/v1`, incl. `openrouter/auto`. **#5 Library tab:** new `library` MainView + sidebar/⌘K entry; cross-conversation index of generated images + artifacts via a pure `collectWorkspaceLibraryItems` join (read-only derived view, no migration). Items #2/#3/#5 from PLAN-cross-product-inspirations | [PLAN](PLAN-cross-product-inspirations.md) · [#167](https://github.com/juchengquan/hummingbird/pull/167) |
| 2026-06-06 | **Vercel AI Gateway per-workspace tagging** — `/api/chat` now attaches `providerOptions.gateway.tags` with `workspace:<workspaceId>` + `model:<modelId>` on every Gateway-routed `streamText` call. The dashboard buckets cost / latency / errors per workspace and per model for free, no Langfuse dep. Skipped when `body.workspaceId` is absent so signed-out turns don't pollute the dashboard with a `workspace:undefined` bucket. Hard no-op on non-gateway routes (`minimax-cn` via `@ai-sdk/anthropic`, self-host via `@ai-sdk/openai-compatible`) — those provider clients ignore the entire `gateway` namespace. Item #4 from PLAN-cross-product-inspirations; Part 1 (`caching: 'auto'`) closed as won't-do (no caching field in any SDK version + Hummingbird's provider mix doesn't pin Vercel as the primary path) | [PLAN](_done/PLAN-gateway-caching-and-workspace-tagging.md) |
| 2026-06-06 | **Conversation-level system prompt** — `Conversation.systemPrompt` lands as the second tier between workspace voice and per-turn persona. `composeSystemPrompts(workspace, conversation, persona)` is persona-additive: switching personas replaces the workspace voice but **keeps** the conversation context. "Thread instructions" entry in the chat-header popover opens a 20K-char editor with explicit Save / Clear (not per-keystroke debounce). New `0021_conversation_system_prompt` migration, `STORE_VERSION 21→22` backfill, sync diff carries `system_prompt`. Item #1 from PLAN-cross-product-inspirations | [PLAN](_done/PLAN-conversation-system-prompt.md) |
| 2026-06-05 | **Per-IP rate buckets + idle watchdog on `/v1/chat`** — both agent services gain a 30 turns / minute / IP gate (`SlidingWindow` in Python, `createSlidingWindow` re-exported in agent-ts) returning 429 + `Retry-After` before the auth / model dispatch path; a 90 s idle watchdog wraps the SSE generator's `next()` on both stacks and emits a synthetic `error` (`code: "upstream"`) + `[DONE]` when an upstream stalls past the window. Mirrors `chatPerIpLimit` + `IDLE_TIMEOUT_MS` in the Next.js inline route. Tests +13 agent-py / +3 agent-ts. Closes the second-to-last item in PLAN-agent-api | [PLAN](PLAN-agent-api.md) · [#161](https://github.com/juchengquan/hummingbird/pull/161) |
| 2026-06-05 | **`POST /v1/mcp/server` CRUD endpoint** — closes the missing write half of the cloud-mode MCP management surface. Both agent services gain `upsert_server_with_credentials` / `upsertServerWithCredentials` wrapping the `mcp_upsert_server_with_credentials` SECURITY DEFINER RPC under per-user RLS impersonation. `apiClient.mcp.upsertCloudServer` honours the backend selector via `DispatchOption` so cloud-mode server CRUD works end-to-end through any of the three backends. Status mapping mirrored: `encryption_key_unset` → 500, RPC failure → 502, missing pool → 503 | [PLAN](PLAN-agent-api.md) · [#160](https://github.com/juchengquan/hummingbird/pull/160) |
| 2026-06-05 | **Frontend perf pass — selectors + persist debounce + deferred messages**: walked the remaining ~10 selector hooks across `conversations` / `documents` / `notes` / `project-tasks` / `prompts` / `ui` / `workspaces` slices and applied `useShallow` + selector-side `.find` / `Map`-build joins (so adding an artifact to another conversation no longer re-renders the sidebar's workspace-documents list); new `lib/client/hooks/store/debounced-storage.ts` wraps localStorage with a 100 ms coalesce window + `pagehide` flush (collapses the `JSON.stringify` churn from per-token SSE updates into one write per quiet period); `useDeferredValue` on the chat message list keeps the composer input responsive while assistant text streams. +7 tests for the storage wrapper. Verified Plate.js is already gated behind `dynamic()` — the 10 MB chunks on disk never load on initial paint | [#159](https://github.com/juchengquan/hummingbird/pull/159) |
| 2026-06-05 | **Code quality pass — selector hygiene + chat-path tests + shared parser**: 6 worst-offending selector hooks switched to `useShallow` + Map-build joins (`useConversationArtifacts`, `useWorkspaceArtifacts`, `useWorkspaceMcpResources`, `useConversationPrivateMcpResources`, `useConversationPrivateUrlBookmarks`, `useWorkspaceUrlBookmarks`); chat-path test extraction: `lib/server/chat/prompt-builders.ts` (14 tests covering composition order + MCP-server pluralisation + multimodal `lastUserText`), `lib/server/chat/suggestions.ts`, `lib/client/chat/auto-retry-decision.ts` (5 tests covering each opt-out branch); `parseSuggestionsJson` consolidated into `lib/shared/suggestions-parser.ts` (3 copies → 1 + 2 re-exports). 959 → 987 Next.js tests | [#158](https://github.com/juchengquan/hummingbird/pull/158) |
| 2026-06-05 | **Chat path + agent-py routers + store cascades refactor — three commits, one PR**: (a) extracted `lib/client/chat/sse-frame-translator.ts` + `lib/client/api/chat-marshalling.ts` from `use-chat-send.ts` + `api-client.ts`, collapsed the four `summarize.*` methods into a single Zod-parameterised helper; (b) split agent-py's `main.py` (950 → 120 LOC) into eight per-domain modules under `services/agent-py/src/agent_py/routers/` (chat / extract / health / images / mcp / summarize / url / whoami) — settings now flow via `Depends(get_settings)` instead of closures; (c) extracted `stripSelectionId(conversations, kind, id)` helper for the four slices (files / resources / mcp / url-bookmarks) that repeated the selection-strip pattern, identity-stable | [#157](https://github.com/juchengquan/hummingbird/pull/157) |
| 2026-06-05 | **Frontend selector for non-chat endpoints** — the Phase 4-2 chat-backend toggle was previously half-honoured; only `/v1/chat` actually routed to the remote backend. New `lib/client/api/backend-resolver.ts` + `DispatchOption` union (`'auto'` / `'in-next'` / `'remote'`) plumbing on `summarize.*`, `mcp.proxy`, `url.fetch`, `images.refreshUrl`. When the user picks a remote backend, all four endpoints now POST to `{baseUrl}/v1/...` with a Bearer JWT; `storagePath` → `storage_path` rename on the refresh-url remote dispatch. Closes the "frontend selector for non-chat endpoints" follow-up; `workspaceId` + per-skill config + `useChat()` adoption all verified shipped in earlier PRs | [PLAN](PLAN-agent-api.md) · [#156](https://github.com/juchengquan/hummingbird/pull/156) |
| 2026-06-05 | **Provider-categorised errors on `/v1/chat`** — Anthropic SDK failures now bucket into stable wire codes (`rate_limit`, `auth`, `context_window`, `upstream`) on all three backends: agent-py `categorize_provider_error` checks typed SDK exceptions first then string-matches gateway-rewrapped errors; agent-ts `categorizeProviderError` mirrors the same logic against `APICallError.statusCode`; Next.js `categorizeError` in `lib/shared/api-errors.ts` gains a `context_window` branch with a permissive regex. `MessageError.code` ladder extended; `ErrorBubble` adds a "Conversation too long" surface that hides Retry and suggests a larger-context fallback model | [PLAN](PLAN-agent-api.md) · [#155](https://github.com/juchengquan/hummingbird/pull/155) |
| 2026-06-02 | **`useChat()` adoption track B.1–B.3 + B.4 closeout** — six PRs that ratified the AI SDK v5 UI message stream as the only wire format across all three backends and put a small translator on the consumer side. B.1a: agent-ts reasoning channel + format-aware `tool_image` (#148). B.1b: agent-py reasoning channel via raw event walk (#149). B.1c+d Next.js: `ChatSseEmitter` + `?format=ai-sdk` (#150). B.1d services: `generate_chat_suggestions` on both services (#151). B.2: `translateFrame` consumer (#152). B.3: retire the legacy custom format (`{type:"text"|"reasoning"|...}`) across all three backends, −1500 LOC net (#153). B.4: closed out as "deferred indefinitely" — adopting `useChat()` as the state machine itself stays unshipped; re-open triggers documented in the plan (#154) | [PLAN](_done/PLAN-useChat-adoption.md) · [#148](https://github.com/juchengquan/hummingbird/pull/148)..[#154](https://github.com/juchengquan/hummingbird/pull/154) |
| 2026-06-01 | **Agent service services parity (PRs #142–#147)** — agent-py Phase 4-3 chat tools + tools-in-chat (#142, #143); Zod 3→4 upgrade across the root + agent-ts (#144, #147); agent cleanup pass — gate in-Next worker + agent-py `workspaceId` + per-skill config + lift extraction (#145); agent-ts `searchFiles` postgres-driver RLS + retire the in-Next agent worker + useChat adoption plan (#146). After this batch `services/agent-py/` and `services/agent-ts/` both run chat-with-tools end-to-end and the Next.js inline worker is gone — vanilla deploys must run one of the dedicated services | [PLAN](PLAN-agent-api.md) · [PLAN](_done/PLAN-agent-ts.md) · [PLAN](_done/PLAN-agent-ts-followups.md) · [#142](https://github.com/juchengquan/hummingbird/pull/142)..[#147](https://github.com/juchengquan/hummingbird/pull/147) |
| 2026-05-30 | **Store slice split — all 5 steps**: `use-store.ts` (3,414 LOC) split into 16 per-entity slice modules under `lib/client/hooks/store/slices/` (`ui`, `chat`, `workspaces`, `conversations`, `messages`, `documents`, `files`, `resources`, `conversation-files`, `mcp`, `url-bookmarks`, `notes`, `artifacts`, `project-tasks`, `prompts`, `agents`) composed into one persisted `useStore` via the standard Zustand "slices pattern" + `SliceCreator<T>`. Persist plumbing extracted to `store/migrate.ts` + `store/persist.ts`; frozen-shape contract pinned by `persist.test.ts` (any add/remove of a persisted key now fails CI until a migration step + `STORE_VERSION` bump are added). `use-store.ts` 3,414 → 263 LOC; no behaviour / persisted-shape / consumer-API change. Tests 761 → 770 | [PLAN](_done/PLAN-store-slice-split.md) · [#115](https://github.com/juchengquan/hummingbird/pull/115) |
| 2026-05-30 | **Chat send-pipeline extraction — all 5 phases**: pure attachment + message builders + `useChatSend` hook covering abort map / streaming flags / live tool-call buffer / mock fallback / 620-LOC pipeline (Phases 1–2, #112); `useSmartPaste` + `useChatDropzone` hooks (Phases 3–4, #113); slash + mention autocomplete state machines → `useSlashAutocomplete` + `usePromptMentionAutocomplete` over a shared pure `navigateAutocomplete` reducer (Phase 5). `chat.tsx` 1,872 → 1,058 (−814 cumulative), clearing the <1,100 target | [PLAN](_done/PLAN-chat-send-extraction.md) · [#112](https://github.com/juchengquan/hummingbird/pull/112) · [#113](https://github.com/juchengquan/hummingbird/pull/113) |
| 2026-05-30 | **Custom agents / personas — all 3 phases**: `0020_agents` migration + workspace-scoped `Agent` type + store slice + `/personas` manage dialog + chat dispatch wiring (Phase 1); MCP allow-list server-side enforcement (`loadEffectiveMcpServers` filter, persisted in `CheckpointConfig`) + share-by-URL (base64url JSON via `?import-agent=`, dropping unknown MCP refs on import) (Phase 2); project-mode "Run as task" picks up the pinned persona's model + prompt + skills + MCP scope (Phase 3) | [PLAN](_done/PLAN-custom-agents.md) · [#107](https://github.com/juchengquan/hummingbird/pull/107) · [#110](https://github.com/juchengquan/hummingbird/pull/110) |
| 2026-05-30 | **Deep Research mode — all 4 phases**: `/research <goal>` slash + research-mode system prompt + manual "Open in editor" button (Phase 1, #101); auto chat-msg + workspace doc + markdown artifact on settle, resume-on-reload carries `mode` (Phase 2, #103); `searchFiles` force-enabled in research mode + files-first prompt branch (Phase 3, #104); pure `formatResearchCitations` renumbers inline `[N]` markers and dedupes the Sources block (Phase 4, #105); auto-handoff wire-up applies the formatter to chat-msg + doc + artifact (#106) | [PLAN](_done/PLAN-deep-research.md) · [#99](https://github.com/juchengquan/hummingbird/pull/99) · [#101](https://github.com/juchengquan/hummingbird/pull/101) · [#103](https://github.com/juchengquan/hummingbird/pull/103) · [#104](https://github.com/juchengquan/hummingbird/pull/104) · [#105](https://github.com/juchengquan/hummingbird/pull/105) · [#106](https://github.com/juchengquan/hummingbird/pull/106) |
| 2026-05-29 | **Code cleanup — Phases 2–6**: sync-layer test coverage (15 new test files, +74 `diff*` tests), reconcile factor-out (`uploadRows` + `anyError` helpers), store-helper extraction (`store-helpers.ts`, −171 LOC from `use-store.ts`, +20 tests), `autoArchiveCodeBlocks` extraction from `chat.tsx` (+7 tests), residual dead-code sweep. Tests 559 → 660; full per-entity store-slice split + full `chat.tsx` send-pipeline extraction remain as scoped follow-ups | [PLAN](_done/PLAN-code-cleanup.md) · [#102](https://github.com/juchengquan/hummingbird/pull/102) |
| 2026-05-29 | **Code cleanup — Phase 1** (quick wins): cleared all 6 baseline lint warnings (unused imports/identifiers, missing useCallback deps in `chat.tsx`, useMemo wrapping in `use-attached-context.ts`); deleted 4 truly-dead exports (`PROJECTED_NODE_KINDS`, `SkillIntent`, `getConversationIntent`, `getSkill`). No functional changes | [PLAN](_done/PLAN-code-cleanup.md) · [#96](https://github.com/juchengquan/hummingbird/pull/96) |
| 2026-05-29 | **Project mode — Phase 5 polish** (all phases complete): milestones editor in the workspace detail sheet, progress bar + milestone chip strip at the top of the Tasks tab, "Hide done" quick filter, Markdown export (`projectToMarkdown` pure helper → goal + milestones + tasks-by-column with linked artifacts inlined), `N/M done` chip on each project workspace's index row | [PLAN](_done/PLAN-project-mode.md) · [#94](https://github.com/juchengquan/hummingbird/pull/94) |
| 2026-05-29 | **Project mode — Phase 4** (per-card "Run as task"): To-do cards launch a long-running task via the shared `useTaskRunContext` (workspace prompt + skills cascade + card title as goal); card moves In progress → Done with a live spinner/step counter, result linked back as a markdown artifact ("View result" → editor); shared `resolveEnabledSkills` helper extracted from the chat send path | [PLAN](_done/PLAN-project-mode.md) · [#91](https://github.com/juchengquan/hummingbird/pull/91) |
| 2026-05-29 | **Workspace canvas — Phases 4–5** (final polish): auto-position artifacts near their source message (Phase 4); inline edge-label editor, snap-to-grid, keyboard nav (Esc deselect, arrow nudge), and PNG export (Phase 5). Mini-map already shipped in Phase 1 | [PLAN](_done/PLAN-workspace-canvas.md) · [#90](https://github.com/juchengquan/hummingbird/pull/90) |
| 2026-05-29 | Agent task queue — **scheduled task runs** (Phase 6 step 7, closes the arc): `0019_task_schedules` table + RLS, `nextRunFromCron` resolver (cron-parser), `dispatchDueSchedules` in the tick, `GET/POST /api/tasks/schedules` + `PATCH/DELETE /:id`, workspace-detail Schedules section | [PLAN](_done/PLAN-agent-task-queue.md) · [#100](https://github.com/juchengquan/hummingbird/pull/100) |
| 2026-05-29 | Agent task queue — **Realtime live tail + visible Queued state** (Phase 6 steps 5+6): `0018_realtime_task_events` adds `task_events` to the Realtime publication; `subscribeTaskEvents` pushes rows to the browser in parallel with the existing poll-tail (idempotent via reduceRun seq); inline pointer differentiates `queued` from `running` | [PLAN](_done/PLAN-agent-task-queue.md) · [#88](https://github.com/juchengquan/hummingbird/pull/88) |
| 2026-05-28 | **Project mode — Phase 2** (Kanban board): `projectTasks` store slice + mutators, pure reorder helper, `project_tasks` sync (diff/reconcile/bulk-upload), gated Tasks rail tab (desktop + mobile), dnd-kit board with manual add / drag / delete | [PLAN](_done/PLAN-project-mode.md) · [#86](https://github.com/juchengquan/hummingbird/pull/86) |
| 2026-05-28 | **Project mode — Phase 1** (schema + project toggle): `0016_project_mode` migration (workspace `is_project`/`goal`/`milestones` + `project_tasks` table), types, `setWorkspaceProjectConfig`, workspace-column sync, detail-sheet toggle + goal | [PLAN](_done/PLAN-project-mode.md) · [#81](https://github.com/juchengquan/hummingbird/pull/81) |
| 2026-05-28 | Agent task queue — **async POST** `/api/tasks` + `/respond` move into the worker (Phase 6 steps 3–4); route enqueues + 202, client opens the resume stream | [PLAN](_done/PLAN-agent-task-queue.md) · [#85](https://github.com/juchengquan/hummingbird/pull/85) |
| 2026-05-28 | **Workspace canvas** — spatial react-flow view (Phases 1–3): canvas surface + node renderers, `canvas_state` persistence + sync (`0015_workspace_canvas`), add / connect / focus | [PLAN](_done/PLAN-workspace-canvas.md) · [#83](https://github.com/juchengquan/hummingbird/pull/83) |
| 2026-05-28 | Agent task queue — **`task_jobs` table + worker + chunking** (Phase 6 steps 1–2): `0014_task_jobs` migration, `enqueueJob`/`processNextJob`, `shouldYield` re-enqueue beating the execution cap | [PLAN](_done/PLAN-agent-task-queue.md) · [#82](https://github.com/juchengquan/hummingbird/pull/82) |
| 2026-05-28 | **Long-running agent tasks — HITL approvals.** Durable checkpoint + `RunEmitter` seed (Phase 1), suspend mechanism + `POST /api/tasks/:id/respond` + gated-tool policy (Phases 2/3), approval card + client respond plumbing (Phase 4), `askUser` tool + multi-choice / free-input (Phase 5). | [PLAN](_done/PLAN-agent-hitl-approvals.md) · [#76](https://github.com/juchengquan/hummingbird/pull/76) |
| 2026-05-28 | Verify-checklist additions for HITL (`askUser`, approval, suspend → reload → respond, interaction edges) | [#77](https://github.com/juchengquan/hummingbird/pull/77) |
| 2026-05-28 | Agent task-queue **architecture plan** (Phase 6 — durable background execution + chunking) | [PLAN](_done/PLAN-agent-task-queue.md) · [#78](https://github.com/juchengquan/hummingbird/pull/78) |
| 2026-05-28 | Long-running agent tasks — **follow-ups grab-bag.** `setPlan` tool + live todo, token coalescing (~96 chars), orphan reconciliation + sweep route, MCP tools (cloud-mode) + per-IP budget gate, resume-on-reload via active-task pointer, finish-while-away notification | [PLAN](_done/PLAN-agent-tasks-followups.md) · [#73](https://github.com/juchengquan/hummingbird/pull/73) |
| 2026-05-28 | Long-running agent tasks — **hybrid UI** (Run-as-task header toggle, dedicated Tasks panel + inline pointer) + client-authored result `Message` | [#72](https://github.com/juchengquan/hummingbird/pull/72) |
| 2026-05-28 | Sidebar resizing + layout responsiveness | _local_ (`0af83d9`) |
| 2026-05-28 | Typed prompt variables (workspace-scoped prompts migration only; type-annotation feature deliberately deferred) | [PLAN](PLAN-typed-prompt-variables.md) · `9b3c84f` |
| 2026-05-27 | Long-running agent tasks — **runner → route → resume → task-card UI → polish** (the five core slices, infrastructure layer; chat-panel wiring landed in #72) | [#69](https://github.com/juchengquan/hummingbird/pull/69) |
| 2026-05-27 | Agent **persistence** — `tasks` + `task_events` tables (migration `0012`), row codec, RLS | [#68](https://github.com/juchengquan/hummingbird/pull/68) |
| 2026-05-27 | Agent **event-model core** — `TaskEvent` IR + projection + `RunEmitter` + wire codec (pure, `lib/shared/agent/`) | [PLAN](_done/PLAN-agent-event-model.md) · [#66](https://github.com/juchengquan/hummingbird/pull/66) |
| 2026-05-24 | Chat input ContextPicker — categorized popover that replaces the `+` button + active-skills chip strip; drag-and-drop file upload on the input card | _local_ |
| 2026-05-24 | `<Textarea>` auto-grow after programmatic value insert (prompt `@`-mention); `SlashHelpDialog` getSnapshot re-render fix | _local_ |
| 2026-05-23 | Slash action commands — `/new`, `/clear`, `/rename`, `/model`, `/help` (run-now, no send) | [PLAN](_done/PLAN-slash-action-commands.md) · [#61](https://github.com/juchengquan/hummingbird/pull/61) |
| 2026-05-23 | Prompt library — Phase 3 (`@<slug>` mention trigger + variable-fill on expand) | [PLAN](_done/PLAN-prompt-library.md) |
| 2026-05-23 | Slash commands — `/` skill surface (parser, autocomplete, force-skill-for-turn) | [PLAN](_done/PLAN-slash-commands.md) · [#55](https://github.com/juchengquan/hummingbird/pull/55) |
| 2026-05-23 | Prompt library — Phase 2 (Supabase sync: `prompts` table, `diffPrompts`, reconcile) | [PLAN](_done/PLAN-prompt-library.md) · [#53](https://github.com/juchengquan/hummingbird/pull/53) |
| 2026-05-23 | Multi-conversation fix — per-message store mutators address by message id | [#52](https://github.com/juchengquan/hummingbird/pull/52) |
| 2026-05-23 | Per-conversation streaming state — switching chats no longer blocks input | [#43](https://github.com/juchengquan/hummingbird/pull/43) |
| 2026-05-23 | Prompt library — Phase 1 (sidebar group, dialogs, click-to-insert) | [PLAN](_done/PLAN-prompt-library.md) · [#50](https://github.com/juchengquan/hummingbird/pull/50) |
| 2026-05-23 | Editor diff mode for AI commands (toggle, review pill, keyboard nav) | [PLAN](_done/PLAN-editor-diff-mode.md) · [#49](https://github.com/juchengquan/hummingbird/pull/49) |
| 2026-05-23 | Cross-device sync for `Message.generatedImages` (metadata column + reconcile) | [#45](https://github.com/juchengquan/hummingbird/pull/45) |
| 2026-05-23 | DOCX / CSV / text file previews | `647b23d` |
| 2026-05-23 | Image handling + right-side viewer drawer integration | `2c1e1ea` |
| 2026-05-22 | "Compress older messages" action with reversible recap | [#37](https://github.com/juchengquan/hummingbird/pull/37) |
| 2026-05-22 | Sandboxed-iframe live artifacts (TSX/HTML/SVG/Mermaid) | [PLAN](_done/PLAN-live-artifacts.md) · [#36](https://github.com/juchengquan/hummingbird/pull/36) |
| 2026-05-22 | File full-text retrieval — all 5 phases (caps, FTS storage, `searchFiles` skill + RPC, UI affordances) | [PLAN](_done/PLAN-file-full-text-retrieval.md) · [TEST](SUPABASE_TEST.md) · [#33](https://github.com/juchengquan/hummingbird/pull/33), [#35](https://github.com/juchengquan/hummingbird/pull/35), [#40](https://github.com/juchengquan/hummingbird/pull/40), [#41](https://github.com/juchengquan/hummingbird/pull/41) |
| 2026-05-22 | Media-preview Download + inline Remix shortcut | [#32](https://github.com/juchengquan/hummingbird/pull/32) |
| 2026-05-22 | Image generation — Storage upload + Remix (I2I) entry | [#29](https://github.com/juchengquan/hummingbird/pull/29) |
| 2026-05-22 | OpenAI-compatible provider type | [#28](https://github.com/juchengquan/hummingbird/pull/28) |
| 2026-05-22 | Image generation A→B→C (Minimax T2I/I2I, SSE frame, gallery + settings) | [#24](https://github.com/juchengquan/hummingbird/pull/24), [#26](https://github.com/juchengquan/hummingbird/pull/26), [#27](https://github.com/juchengquan/hummingbird/pull/27) |
| 2026-05-22 | Server-side skill registry refactor | [#21](https://github.com/juchengquan/hummingbird/pull/21) |
| 2026-05-22 | Web search — Exa as a third provider | [#18](https://github.com/juchengquan/hummingbird/pull/18) |
| 2026-05-22 | Model picker refresh + Minimax-CN bypass + Web fetch | `cd2a666` |

**Earlier features** (kept for reference, no specific date):

- ✅ Conversation graph view (branching/forking)
- ✅ URL bookmarks as live sources — [PLAN](_done/PLAN-url-bookmarks.md)
- ✅ MCP integration (Stages 1–3) — [PLAN](_done/PLAN-mcp-integration.md), [Stage 3 detail](_done/PLAN-mcp-stage-3.md)
- ✅ Smart paste — [PLAN](_done/PLAN-smart-paste.md)
- ✅ Skills panel + Web search — [PLAN](_done/PLAN-skills-panel-and-web-search.md)
- ✅ Explain-selection — [PLAN](_done/PLAN-explain-selection.md)
- ✅ Conversation-private file attachments — [PLAN](_done/PLAN-conversation-private-files.md)
- ✅ Chat experience batch (markdown / vision / system prompts) — [PLAN](_done/PLAN-chat-experience-batch.md)
- ✅ Attachments polymorphism (file / MCP / URL bookmark union) — [PLAN](_done/PLAN-attachments-polymorphism.md)
- ✅ Client/server fences (`lib/{client,server,shared}/`) — [PLAN](_done/PLAN-client-server-fences.md)
- ✅ Backend extraction Phase 1 (API surface + Zod schemas) — [PLAN](PLAN-backend-extraction.md)
- ✅ Reasoning / "thinking" tokens
- ✅ Auto-retry-once on transient errors + rate-limit cooldown
- ✅ Inline citations from web search
- ✅ Pinned default model per workspace
- ✅ Context-window meter (token estimator + color zones)
- ✅ Annotated PDF viewer
- ✅ Cross-conversation search + ⌘K command palette
- ✅ Export & sharing (Markdown / artifact / share links)
- ✅ Message-level actions (copy / edit / regenerate / delete)
- ✅ Supabase Phase 1 (auth + sync layer)

---

## Conventions

### When a feature ships

1. Move the row from **Next** → **Shipped log** here, with date + PR.
2. Update the `PLAN-*.md` file's `Status:` line to `✅ shipped` plus the
   PR link.
3. **If the plan is fully shipped** (all phases done, nothing pending),
   `git mv docs/PLAN-<name>.md docs/_done/` and re-point any links to
   it (here and from other plans) at `_done/`. Phased plans with
   pending work stay in `docs/` until the last phase lands.
4. If the work surfaced new follow-ups, append them to the
   **Small follow-ups batch** plan (or to **Later — distinctive ideas**
   above if they're full-feature shaped).

### When a new plan is drafted

1. Add a `PLAN-<name>.md` with `Status: **planning**`.
2. Link it from **Next** here.
3. If it replaces a **Later** entry above, prune the entry to a single
   "→ see PLAN-<name>.md" line.

### When work starts on a plan

1. Update the `Status:` in the plan file.
2. Move the row from **Next** → **Now** here with the branch name.

### When a "Later" idea earns a plan

Promote it to **Next** with a one-line link to the new `PLAN-*.md`,
and either prune the **Later** section entry to a redirect pointer or
delete it outright if the plan supersedes the prose entirely.
