# Roadmap

The single source of truth for what's shipped, what's planned, and
what's still loose on the backlog. Per-feature detail lives in the
linked `PLAN-*.md` files; raw ideas not yet shaped into a plan live
in `BACKLOG.md`.

Update this file whenever a feature ships, a plan lands, or a new
plan is drafted. When a backlog item gets a plan, link it from the
**Planned** section below and trim the backlog entry to a one-liner
pointing at the plan.

Last updated: 2026-05-22 (PR #37).

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
| 2026-05-22 | "Compress older messages" action with reversible recap | [#37](https://github.com/juchengquan/hummingbird/pull/37) |
| 2026-05-22 | Sandboxed-iframe live artifacts (TSX/HTML/SVG/Mermaid) | [PLAN](PLAN-live-artifacts.md) · [#36](https://github.com/juchengquan/hummingbird/pull/36) |
| 2026-05-22 | File full-text retrieval — Phases 1 + 2 (caps + FTS storage) | [PLAN](PLAN-file-full-text-retrieval.md) · [#33](https://github.com/juchengquan/hummingbird/pull/33), [#35](https://github.com/juchengquan/hummingbird/pull/35) |
| 2026-05-22 | Media-preview Download + inline Remix shortcut | [#32](https://github.com/juchengquan/hummingbird/pull/32) |
| 2026-05-22 | Image generation — Storage upload + Remix (I2I) entry | [#29](https://github.com/juchengquan/hummingbird/pull/29) |
| 2026-05-22 | OpenAI-compatible provider type | [#28](https://github.com/juchengquan/hummingbird/pull/28) |
| 2026-05-22 | Image generation A→B→C (Minimax T2I/I2I, SSE frame, gallery + settings) | [#24](https://github.com/juchengquan/hummingbird/pull/24), [#26](https://github.com/juchengquan/hummingbird/pull/26), [#27](https://github.com/juchengquan/hummingbird/pull/27) |
| 2026-05-22 | Server-side skill registry refactor | [#21](https://github.com/juchengquan/hummingbird/pull/21) |
| 2026-05-22 | Web search — Exa as a third provider | [#18](https://github.com/juchengquan/hummingbird/pull/18) |
| 2026-05-22 | Model picker refresh + Minimax-CN bypass + Web fetch | `cd2a666` |

Earlier features (kept for reference, no specific date):

- ✅ Conversation graph view (branching/forking)
- ✅ URL bookmarks as live sources — [PLAN](PLAN-url-bookmarks.md)
- ✅ MCP integration (Stages 1–3) — [PLAN](PLAN-mcp-integration.md), [Stage 3 detail](PLAN-mcp-stage-3.md)
- ✅ Smart paste — [PLAN](PLAN-smart-paste.md)
- ✅ Skills panel + Web search — [PLAN](PLAN-skills-panel-and-web-search.md)
- ✅ Explain-selection — [PLAN](PLAN-explain-selection.md)
- ✅ Conversation-private file attachments — [PLAN](PLAN-conversation-private-files.md)
- ✅ Chat experience batch (markdown / vision / system prompts) — [PLAN](PLAN-chat-experience-batch.md)
- ✅ Attachments polymorphism (file / MCP / URL bookmark union) — [PLAN](PLAN-attachments-polymorphism.md)
- ✅ Client/server fences (`lib/{client,server,shared}/`) — [PLAN](PLAN-client-server-fences.md)
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
| 🚧 Slash commands for skill chaining | `claude/slash-commands` | [PLAN](PLAN-slash-commands.md) — autocomplete + parser; v1: `/search`, `/fetch`, `/image` |

---

## Planned (have a PLAN, no code yet)

| Plan | Status | Sketch |
|---|---|---|
| 📐 [Editor diff mode](PLAN-editor-diff-mode.md) | planning | Before / after chunks with accept-reject for editor AI commands |
| 📐 [Prompt library](PLAN-prompt-library.md) | planning | Reusable prompts with variable substitution |
| 🪜 [File full-text retrieval](PLAN-file-full-text-retrieval.md) | Phase 3 pending | `searchFiles` skill + RAG over `files.full_text` |
| 🪜 [Backend extraction](PLAN-backend-extraction.md) | Phase 2 pending | Python backend rewrite (gated on a clear product win) |

---

## Backlog (no plan yet)

The full list lives in [BACKLOG.md](BACKLOG.md). Highlights:

- 💡 Cross-conversation memory with retrieval (pgvector + embeddings)
- 💡 Long-running task mode (async, step-based, notifications)
- 💡 Workspace canvas (spatial drag-drop view)
- 💡 Project mode (Kanban tasks + goal tracking)

---

## Known small follow-ups

Not full features — polish items, deferred sub-tasks. Each is a half-day
or less and doesn't need its own plan.

- Cross-device sync of `Message.generatedImages` metadata (storage path
  + signed-URL refresh on render). The bytes are already durable in
  Supabase Storage; only the message row needs catching up.
- Accurate per-family token counting in `lib/shared/tokens.ts` — replace
  the `chars/4` heuristic with `js-tiktoken` for OpenAI/Anthropic, keep
  heuristic elsewhere.
- "Summarize" of an existing recap when the user re-compresses
  (currently the new recap stacks alongside the old). Low priority —
  cleanup happens naturally if the recap is undone.
- Lazy signed-URL re-sign for generated images when the 1-year TTL
  eventually expires. Defer until anyone hits it.

---

## Conventions

When a feature ships:

1. Move the row from **Planned** → **Shipped** here, with date + PR.
2. Update the `PLAN-*.md` file's `Status:` line to `✅ shipped` plus the
   PR link.
3. If the work surfaced new follow-ups, append them to **Known small
   follow-ups** (or to `BACKLOG.md` if they're full-feature shaped).

When a new plan is drafted:

1. Add a `PLAN-<name>.md` with `Status: **planning**`.
2. Link it from **Planned** here.
3. If it replaces a backlog entry, prune the backlog entry to a single
   "→ see PLAN-<name>.md" line.

When work starts on a plan:

1. Update the `Status:` in the plan file.
2. Move the row from **Planned** → **In progress** here with the
   branch name.
