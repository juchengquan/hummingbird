# Roadmap

The single source of truth for what's shipped, what's planned, and
what's still loose on the backlog. Per-feature detail lives in the
linked `PLAN-*.md` files; raw ideas not yet shaped into a plan live
in `BACKLOG.md`.

Update this file whenever a feature ships, a plan lands, or a new
plan is drafted. When a backlog item gets a plan, link it from the
**Planned** section below and trim the backlog entry to a one-liner
pointing at the plan.

Last updated: 2026-05-23 (prompt-library Phase 3 `@`-mentions shipped;
plan fully done → archived to `_done/`).

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

---

## Shipped (recent first)

Newest at the top. Each row links to the plan if there is one, or
to a representative PR otherwise.

| When | Feature | Where |
|---|---|---|
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
inside the plan; only the listed phase(s) remain. The slash-commands
core and the full prompt-library (all 3 phases) shipped and are
archived in [`_done/`](_done/); slash-commands' remaining `/` run-now
sub-surface is tracked below as its own plan.

| Plan | Status | Sketch |
|---|---|---|
| 📐 [Slash action commands](PLAN-slash-action-commands.md) | planning | `/clear`, `/rename`, `/new`, `/model`, `/help` — run-now commands, no send |
| 📐 [Cross-conversation memory with retrieval](PLAN-cross-conversation-memory.md) | planning | pgvector + `memoryRecall` skill |
| 📐 [Local RAG vector store](PLAN-local-rag.md) | decision doc | Where embeddings live — Supabase pgvector / self-host Postgres / in-browser PGlite. No driver chosen |
| 📐 [Long-running task mode](PLAN-long-running-tasks.md) | planning | Async step-based agent with progress + notifications |
| 📐 [Workspace canvas](PLAN-workspace-canvas.md) | planning | Spatial drag-drop view of messages / artifacts / files |
| 📐 [Project mode](PLAN-project-mode.md) | planning | Workspace → goal + milestones + Kanban tasks (depends on long-running tasks) |
| 🪜 [Small follow-ups batch](PLAN-small-followups.md) | 2 of 5 done | Done: generatedImages sync (#45), roadmap sweep. Open: accurate tokens, recap-of-recaps, signed-URL re-sign |
| 🪜 [Backend extraction](PLAN-backend-extraction.md) | Phase 2 pending | Python backend rewrite (gated on a clear product win) |

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
