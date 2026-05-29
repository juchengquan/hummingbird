# Roadmap

The single source of truth for what's shipped, what's planned, and
what's still loose on the backlog. Per-feature detail lives in the
linked `PLAN-*.md` files; raw ideas not yet shaped into a plan live
in `BACKLOG.md`.

Update this file whenever a feature ships, a plan lands, or a new
plan is drafted. When a backlog item gets a plan, link it from the
**Planned** section below and trim the backlog entry to a one-liner
pointing at the plan.

Last updated: 2026-05-30 (sweep — PLAN-project-mode + PLAN-workspace-
canvas moved to _done/ now that all phases ship; PLAN-agent-task-queue
status bumped from steps 1–4 to steps 1–6 to reflect #88; small-
followups #6 — local-mode MCP creds for tasks — marked moot per #85,
which rejects local-mode in async task mode by design. Project mode
complete via #81/#86/#89/#91/#94; workspace canvas via #83/#90; agent
task-queue steps 1–6 via #82/#85/#88. Only the optional queue step 7
(scheduling) remains in the agent-task arc. Code-cleanup Phase 1
shipped via #96 — lint baseline now 0 warnings, 4 dead exports
removed; 5 structural phases pending in `PLAN-code-cleanup.md`.)

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
| 2026-05-29 | **Code cleanup — Phase 1** (quick wins): cleared all 6 baseline lint warnings (unused imports/identifiers, missing useCallback deps in `chat.tsx`, useMemo wrapping in `use-attached-context.ts`); deleted 4 truly-dead exports (`PROJECTED_NODE_KINDS`, `SkillIntent`, `getConversationIntent`, `getSkill`). No functional changes | [PLAN](PLAN-code-cleanup.md) · [#96](https://github.com/juchengquan/hummingbird/pull/96) |
| 2026-05-29 | **Project mode — Phase 5 polish** (all phases complete): milestones editor in the workspace detail sheet, progress bar + milestone chip strip at the top of the Tasks tab, "Hide done" quick filter, Markdown export (`projectToMarkdown` pure helper → goal + milestones + tasks-by-column with linked artifacts inlined), `N/M done` chip on each project workspace's index row | [PLAN](_done/PLAN-project-mode.md) · [#94](https://github.com/juchengquan/hummingbird/pull/94) |
| 2026-05-29 | **Project mode — Phase 4** (per-card "Run as task"): To-do cards launch a long-running task via the shared `useTaskRunContext` (workspace prompt + skills cascade + card title as goal); card moves In progress → Done with a live spinner/step counter, result linked back as a markdown artifact ("View result" → editor); shared `resolveEnabledSkills` helper extracted from the chat send path | [PLAN](_done/PLAN-project-mode.md) · [#91](https://github.com/juchengquan/hummingbird/pull/91) |
| 2026-05-29 | **Workspace canvas — Phases 4–5** (final polish): auto-position artifacts near their source message (Phase 4); inline edge-label editor, snap-to-grid, keyboard nav (Esc deselect, arrow nudge), and PNG export (Phase 5). Mini-map already shipped in Phase 1 | [PLAN](_done/PLAN-workspace-canvas.md) · [#90](https://github.com/juchengquan/hummingbird/pull/90) |
| 2026-05-29 | Agent task queue — **Realtime live tail + visible Queued state** (Phase 6 steps 5+6): `0018_realtime_task_events` adds `task_events` to the Realtime publication; `subscribeTaskEvents` pushes rows to the browser in parallel with the existing poll-tail (idempotent via reduceRun seq); inline pointer differentiates `queued` from `running` | [PLAN](PLAN-agent-task-queue.md) · [#88](https://github.com/juchengquan/hummingbird/pull/88) |
| 2026-05-28 | **Project mode — Phase 2** (Kanban board): `projectTasks` store slice + mutators, pure reorder helper, `project_tasks` sync (diff/reconcile/bulk-upload), gated Tasks rail tab (desktop + mobile), dnd-kit board with manual add / drag / delete | [PLAN](_done/PLAN-project-mode.md) · [#86](https://github.com/juchengquan/hummingbird/pull/86) |
| 2026-05-28 | **Project mode — Phase 1** (schema + project toggle): `0016_project_mode` migration (workspace `is_project`/`goal`/`milestones` + `project_tasks` table), types, `setWorkspaceProjectConfig`, workspace-column sync, detail-sheet toggle + goal | [PLAN](_done/PLAN-project-mode.md) · [#81](https://github.com/juchengquan/hummingbird/pull/81) |
| 2026-05-28 | Agent task queue — **async POST** `/api/tasks` + `/respond` move into the worker (Phase 6 steps 3–4); route enqueues + 202, client opens the resume stream | [PLAN](PLAN-agent-task-queue.md) · [#85](https://github.com/juchengquan/hummingbird/pull/85) |
| 2026-05-28 | **Workspace canvas** — spatial react-flow view (Phases 1–3): canvas surface + node renderers, `canvas_state` persistence + sync (`0015_workspace_canvas`), add / connect / focus | [PLAN](_done/PLAN-workspace-canvas.md) · [#83](https://github.com/juchengquan/hummingbird/pull/83) |
| 2026-05-28 | Agent task queue — **`task_jobs` table + worker + chunking** (Phase 6 steps 1–2): `0014_task_jobs` migration, `enqueueJob`/`processNextJob`, `shouldYield` re-enqueue beating the execution cap | [PLAN](PLAN-agent-task-queue.md) · [#82](https://github.com/juchengquan/hummingbird/pull/82) |
| 2026-05-28 | **Long-running agent tasks — HITL approvals.** Durable checkpoint + `RunEmitter` seed (Phase 1), suspend mechanism + `POST /api/tasks/:id/respond` + gated-tool policy (Phases 2/3), approval card + client respond plumbing (Phase 4), `askUser` tool + multi-choice / free-input (Phase 5). | [PLAN](_done/PLAN-agent-hitl-approvals.md) · [#76](https://github.com/juchengquan/hummingbird/pull/76) |
| 2026-05-28 | Verify-checklist additions for HITL (`askUser`, approval, suspend → reload → respond, interaction edges) | [#77](https://github.com/juchengquan/hummingbird/pull/77) |
| 2026-05-28 | Agent task-queue **architecture plan** (Phase 6 — durable background execution + chunking) | [PLAN](PLAN-agent-task-queue.md) · [#78](https://github.com/juchengquan/hummingbird/pull/78) |
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
HITL approvals) now ships — its plans live in [`_done/`](_done/). The
queue-backed continuation is **mostly shipped** too (Phase 6 steps 1–6
via #82/#85/#88); only the optional step 7 (scheduling) remains.

| Plan | Status | Sketch |
|---|---|---|
| 🪜 [Agent task queue (durable background execution)](PLAN-agent-task-queue.md) | steps 1–6 shipped (#82, #85, #88) | `task_jobs` queue + worker + chunking + async start/respond + Realtime live tail + visible Queued state done. Remaining: optional step 7 (scheduling — `task_schedules` + cron resolver for "run every morning") |
| 🪜 [Small follow-ups batch](PLAN-small-followups.md) | 3 done, 1 moot, 4 open | Done: generatedImages sync (#45), recap-of-recaps (#63), roadmap sweep. Moot: local-mode MCP creds for tasks (rejected up front by #85). Open: accurate tokens, signed-URL re-sign, per-tool server-side approval flags, task-route integration tests |
| 🪜 [Code cleanup](PLAN-code-cleanup.md) | Phase 1 shipped (#96) | 6 phases of housecleaning after a long feature push — lint baseline + dead exports done; sync test coverage, reconcile factor-out, `use-store.ts` slice split, `chat.tsx` send-pipeline extraction, dead code sweep pending. No functional changes |
| 📐 [Cross-conversation memory with retrieval](PLAN-cross-conversation-memory.md) | planning | pgvector + `memoryRecall` skill |
| 📐 [Local RAG vector store](PLAN-local-rag.md) | decision doc | Where embeddings live — Supabase pgvector / self-host Postgres / in-browser PGlite. No driver chosen |
| 📐 [Replace Supabase with self-hosted Postgres](PLAN-replace-supabase-with-postgres.md) | planning | Infrastructure migration — 5 phases, ~7.5 days total |
| 📐 [Agent API as a separate service](PLAN-agent-api.md) | decision doc | Language-agnostic target shape for splitting inference + agent loop out; TS-service or Python, undecided. Distinct from the in-process task queue above |
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
