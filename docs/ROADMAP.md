# Roadmap

The single source of truth for what's shipped, what's planned, and
what's still loose on the backlog. Per-feature detail lives in the
linked `PLAN-*.md` files; raw ideas not yet shaped into a plan live
in `BACKLOG.md`.

Update this file whenever a feature ships, a plan lands, or a new
plan is drafted. When a backlog item gets a plan, link it from the
**Planned** section below and trim the backlog entry to a one-liner
pointing at the plan.

Last updated: 2026-05-30 (PLAN-agent-api Phase 1 shipped —
`services/agent-py/` now polls `task_jobs` in dry-run alongside the
TS worker: `db.py` (asyncpg pool lifecycle), `jobs.py`
(`claim_next_job` using `FOR UPDATE SKIP LOCKED` + dry-run release),
`poller.py` (async tick loop wired into FastAPI lifespan, transient-
error tolerant, cancellation-clean). Settings extended with
`SUPABASE_DB_URL` + `WORKER_DRY_RUN` + `POLL_INTERVAL_SECONDS`;
`/readyz` reports DB pool state; 17 new unit tests. Earlier today:
agent-py Phase 0 (#119), host decision (#120), signed-URL re-sign
(#116), store-slice-split (#115), chat-send-pipeline (#112/#113),
Deep Research mode + Custom agents / personas + agent task-queue
arc. Active plans now: small-followups (3 open: tokens / per-tool
approval flags / task-route integration tests), agent-api (Phase 2
pending — executor branch + 3 tools), cross-conversation-memory,
local-rag, replace-supabase, backend-extraction, typed-prompt-vars.)

> **Plan archive.** Fully-shipped `PLAN-*.md` files live in
> [`_done/`](_done/). Active plans (planning / phased / decision
> docs) stay in `docs/`. Links below point at wherever the plan
> currently lives.

---

## Status legend

- ✅ **Shipped** — merged to `dev`, live in the app.
- 🚧 **In progress** — branch exists, work underway.
- 📐 **Planned** — `PLAN-*.md` exists, no code yet.
- 💡 **Backlog** — see `BACKLOG.md`. No plan yet.
- 🪜 **Phased** — partial ship; sub-phases tracked inside the plan.
- ⏸ **Deferred** — `PLAN-*.md` exists; explicit decision not to build
  until evidence demands it (e.g. real user requests).

---

## Shipped (recent first)

Newest at the top. Each row links to the plan if there is one, or
to a representative PR otherwise.

| When | Feature | Where |
|---|---|---|
| 2026-05-30 | **Store slice split — all 5 steps**: `use-store.ts` (3,414 LOC) split into 16 per-entity slice modules under `lib/client/hooks/store/slices/` (`ui`, `chat`, `workspaces`, `conversations`, `messages`, `documents`, `files`, `resources`, `conversation-files`, `mcp`, `url-bookmarks`, `notes`, `artifacts`, `project-tasks`, `prompts`, `agents`) composed into one persisted `useStore` via the standard Zustand "slices pattern" + `SliceCreator<T>`. Persist plumbing extracted to `store/migrate.ts` + `store/persist.ts`; frozen-shape contract pinned by `persist.test.ts` (any add/remove of a persisted key now fails CI until a migration step + `STORE_VERSION` bump are added). `use-store.ts` 3,414 → 263 LOC; no behaviour / persisted-shape / consumer-API change. Tests 761 → 770 | [PLAN](_done/PLAN-store-slice-split.md) · [#115](https://github.com/juchengquan/hummingbird/pull/115) |
| 2026-05-30 | **Chat send-pipeline extraction — all 5 phases**: pure attachment + message builders + `useChatSend` hook covering abort map / streaming flags / live tool-call buffer / mock fallback / 620-LOC pipeline (Phases 1–2, #112); `useSmartPaste` + `useChatDropzone` hooks (Phases 3–4, #113); slash + mention autocomplete state machines → `useSlashAutocomplete` + `usePromptMentionAutocomplete` over a shared pure `navigateAutocomplete` reducer (Phase 5). `chat.tsx` 1,872 → 1,058 (−814 cumulative), clearing the <1,100 target | [PLAN](_done/PLAN-chat-send-extraction.md) · [#112](https://github.com/juchengquan/hummingbird/pull/112) · [#113](https://github.com/juchengquan/hummingbird/pull/113) |
| 2026-05-30 | **Custom agents / personas — all 3 phases**: `0020_agents` migration + workspace-scoped `Agent` type + store slice + `/personas` manage dialog + chat dispatch wiring (Phase 1); MCP allow-list server-side enforcement (`loadEffectiveMcpServers` filter, persisted in `CheckpointConfig`) + share-by-URL (base64url JSON via `?import-agent=`, dropping unknown MCP refs on import) (Phase 2); project-mode "Run as task" picks up the pinned persona's model + prompt + skills + MCP scope (Phase 3) | [PLAN](_done/PLAN-custom-agents.md) · [#107](https://github.com/juchengquan/hummingbird/pull/107) · [#110](https://github.com/juchengquan/hummingbird/pull/110) |
| 2026-05-30 | **Deep Research mode — all 4 phases**: `/research <goal>` slash + research-mode system prompt + manual "Open in editor" button (Phase 1, #101); auto chat-msg + workspace doc + markdown artifact on settle, resume-on-reload carries `mode` (Phase 2, #103); `searchFiles` force-enabled in research mode + files-first prompt branch (Phase 3, #104); pure `formatResearchCitations` renumbers inline `[N]` markers and dedupes the Sources block (Phase 4, #105); auto-handoff wire-up applies the formatter to chat-msg + doc + artifact (#106) | [PLAN](_done/PLAN-deep-research.md) · [#99](https://github.com/juchengquan/hummingbird/pull/99) · [#101](https://github.com/juchengquan/hummingbird/pull/101) · [#103](https://github.com/juchengquan/hummingbird/pull/103) · [#104](https://github.com/juchengquan/hummingbird/pull/104) · [#105](https://github.com/juchengquan/hummingbird/pull/105) · [#106](https://github.com/juchengquan/hummingbird/pull/106) |
| 2026-05-29 | **Code cleanup — Phases 2–6**: sync-layer test coverage (15 new test files, +74 `diff*` tests), reconcile factor-out (`uploadRows` + `anyError` helpers), store-helper extraction (`store-helpers.ts`, −171 LOC from `use-store.ts`, +20 tests), `autoArchiveCodeBlocks` extraction from `chat.tsx` (+7 tests), residual dead-code sweep. Tests 559 → 660; full per-entity store-slice split + full `chat.tsx` send-pipeline extraction remain as scoped follow-ups | [PLAN](PLAN-code-cleanup.md) · [#102](https://github.com/juchengquan/hummingbird/pull/102) |
| 2026-05-29 | **Code cleanup — Phase 1** (quick wins): cleared all 6 baseline lint warnings (unused imports/identifiers, missing useCallback deps in `chat.tsx`, useMemo wrapping in `use-attached-context.ts`); deleted 4 truly-dead exports (`PROJECTED_NODE_KINDS`, `SkillIntent`, `getConversationIntent`, `getSkill`). No functional changes | [PLAN](PLAN-code-cleanup.md) · [#96](https://github.com/juchengquan/hummingbird/pull/96) |
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

Earlier features (kept for reference, no specific date):

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

## In progress

| Plan | Branch | Notes |
|---|---|---|
| _(nothing actively in flight)_ | | |

---

## Planned (have a PLAN, no code yet)

The `🪜` rows are partial ships — their finished phases are documented
inside the plan; only the listed phase(s) remain. The entire long-running
agent-tasks stack (event-model, runner, route, resume, hybrid UI,
HITL approvals, **and the queue-backed continuation incl. scheduling**)
now ships — its plans live in [`_done/`](_done/).

| Plan | Status | Sketch |
|---|---|---|
| 🪜 [Small follow-ups batch](PLAN-small-followups.md) | 4 done, 1 moot, 3 open | Done: generatedImages sync (#45), recap-of-recaps (#63), roadmap sweep, signed-URL re-sign. Moot: local-mode MCP creds for tasks (rejected up front by #85). Open: accurate tokens, per-tool server-side approval flags, task-route integration tests |
| 🪜 [Code cleanup](PLAN-code-cleanup.md) | Phases 1–6 shipped (#96, #102) | 6 phases of housecleaning after a long feature push. Phase 1 cleared lint baseline + 4 dead exports; Phases 2–6 added per-entity sync diff tests, factored `reconcile.ts`, extracted store helpers + the `chat.tsx` auto-archive heuristic, and removed a residual dead export. The full per-entity store-slice split and the full `chat.tsx` send-pipeline extraction have both shipped — see their rows in **Shipped** above. No functional changes |
| 📐 [Cross-conversation memory with retrieval](PLAN-cross-conversation-memory.md) | planning | pgvector + `memoryRecall` skill |
| 📐 [Local RAG vector store](PLAN-local-rag.md) | decision doc | Where embeddings live — Supabase pgvector / self-host Postgres / in-browser PGlite. No driver chosen |
| 📐 [Replace Supabase with self-hosted Postgres](PLAN-replace-supabase-with-postgres.md) | planning | Infrastructure migration — 5 phases, ~7.5 days total |
| 🪜 [Agent API as a separate service](PLAN-agent-api.md) | Phases 0+1 shipped — Phase 2 pending | Six-phase plan to move the agent loop + worker + tools out of Next.js into a Python FastAPI service. **Option C (Python) green-lit**; **Phase 0** (scaffolding) + **Phase 1** (read-only `task_jobs` poller using `FOR UPDATE SKIP LOCKED`, dry-run release, async lifespan) both shipped at `services/agent-py/`. Host decision landed: self-host on a small VM (~€4.5/mo Hetzner CX22, or home server / NAS) — reasoning in PLAN-agent-api §Host decision. Phase 2 lands the executor branch (port `runAgentLoop` + 3 tools); Phase 3 adds MCP + remaining tools + streaming format switch; Phase 4 ports the chat turn; Phase 5 cuts over; Phase 6 tidies. ~4-6 weeks total; phases 0-4 are flag-flip reversible |
| 🪜 [Backend extraction](PLAN-backend-extraction.md) | Phase 2 pending | Phase 1 (contract-first frontend ⇄ API surface) shipped; Phase 2 stands up the Python backend |
| ⏸ [Typed prompt variables](PLAN-typed-prompt-variables.md) | deferred | Workspace-scoping migration shipped (`9b3c84f`); the typing UI itself remains deliberately deferred |

---

## Backlog (no plan yet)

The full list lives in [BACKLOG.md](BACKLOG.md). Everything currently
there now has a plan — see the **Planned** table above. Add new
ideas to `BACKLOG.md` first; promote them here when they get a plan.

---

## Conventions

When a feature ships:

1. Move the row from **Planned** → **Shipped** here, with date + PR.
2. Update the `PLAN-*.md` file's `Status:` line to `✅ shipped` plus the
   PR link.
3. **If the plan is fully shipped** (all phases done, nothing pending),
   `git mv docs/PLAN-<name>.md docs/_done/` and re-point any links to
   it (here and from other plans) at `_done/`. Phased plans with
   pending work stay in `docs/` until the last phase lands.
4. If the work surfaced new follow-ups, append them to the
   **Small follow-ups batch** plan (or to `BACKLOG.md` if they're
   full-feature shaped).

When a new plan is drafted:

1. Add a `PLAN-<name>.md` with `Status: **planning**`.
2. Link it from **Planned** here.
3. If it replaces a backlog entry, prune the backlog entry to a single
   "→ see PLAN-<name>.md" line.

When work starts on a plan:

1. Update the `Status:` in the plan file.
2. Move the row from **Planned** → **In progress** here with the
   branch name.
