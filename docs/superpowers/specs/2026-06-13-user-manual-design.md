# Hummingbird User Manual — Design

**Status:** Draft, awaiting user review
**Date:** 2026-06-13
**Branch:** `dev`

## Background

Hummingbird today has a developer-oriented `README.md` and a deep
collection of `docs/PLAN-*.md` and `docs/_done/PLAN-*.md` files. None
of these are written for the people who actually *use* the app: the
end user opening the chat panel, the self-hoster wiring up Supabase,
the new user discovering slash commands.

The `design_documents/` folder is an internal feature inventory
(purpose: "what does the codebase contain?"), not a user manual. It
references source files, store slices, and component paths — useful
for contributors, useless for a non-developer trying to attach a file
to a chat.

We need a version-controlled user manual that:

1. Covers every user-facing feature.
2. Serves both audiences (end users, self-hosters) from one index.
3. Stays reasonably complete as features land — not by enforcement,
   but by giving the author a discoverable checklist of what's new.

## Approach

Write a static, hand-authored Markdown manual under `docs/user-manual/`,
powered by a small two-script pipeline that:

1. **Scans the codebase** for user-facing surfaces (panels, sidebars,
   slash commands, settings, env vars, keyboard shortcuts, MCP server
   touchpoints, agent task types) and emits a JSON
   `.feature-inventory.json`.
2. **Builds the top-level `index.md` TOC** from that JSON, using a
   hand-maintained `PAGE_MAP` that links each inventory id to the page
   that documents it. Inventory entries without a mapping show up
   under an "Unmapped (action needed)" section — the author's
   "what's left to document" checklist.

Both files are generated and committed, so the manual is browsable on
GitHub without running the build.

## Goals

- A single, version-controlled user manual covering every user-facing
  feature in Hummingbird.
- Two clearly-separated parts inside one manual:
  - **Part 1 — Using Hummingbird** (end users, no dev knowledge assumed)
  - **Part 2 — Installing & Configuring** (self-hosters, Bun + Docker
    + Postgres literate)
- A static-analysis feature inventory that gives the author a
  discoverable checklist of new features as they land.
- An auto-generated `index.md` TOC sourced from the inventory — TOC
  can't drift from the inventory by accident.
- Best-effort maintenance: no CI enforcement, no PR-template nudge.
  Reviewer judgement.

## Non-goals

- No screenshots, no Mermaid diagrams. Text-first.
- No in-app help system. The inventory is structured to make a future
  `/help` route possible, but that's a separate project.
- No separate docs site (Docusaurus, Nextra, MkDocs).
- No automatic enforcement of "every feature must be documented." The
  inventory + "Unmapped" section is a nudge, not a gate.
- No internationalization. English only.
- No auto-update of the manual's prose. Only the TOC and inventory
  are generated.

## Repository layout

```
docs/
└── user-manual/
    ├── index.md                      # Generated. Top-level TOC.
    ├── .feature-inventory.json       # Generated. Authoritative list of user-facing surfaces.
    ├── 01-getting-started.md         # Hand-written.
    ├── 02-chat.md
    ├── 03-editor.md
    ├── 04-files-and-attachments.md
    ├── 05-conversations-and-workspaces.md
    ├── 06-slash-commands.md
    ├── 07-skills-and-tools.md        # Web search, MCP, code execution.
    ├── 08-agent-tasks.md
    ├── 09-canvas.md                  # Flowchat.
    ├── 10-prompt-library.md
    ├── 11-notes-and-bookmarks.md
    ├── 12-settings-and-theme.md
    ├── 13-keyboard-shortcuts.md
    ├── 20-installation.md            # Part 2 begins.
    ├── 21-environment-variables.md
    ├── 22-supabase-setup.md          # Mostly pointers to existing docs/SUPABASE_*.md.
    ├── 23-model-providers.md         # AI Gateway, Ollama, OpenRouter, Minimax-CN.
    ├── 24-mcp-server-config.md
    ├── 25-encryption-keys.md         # MCP_ENCRYPTION_KEY.
    ├── 26-troubleshooting.md
    └── 27-architecture-overview.md   # High-level "how it fits together" for self-hosters.

scripts/
├── list-user-features.ts             # Scans codebase → .feature-inventory.json
├── build-user-manual-toc.ts          # Reads inventory → index.md
└── __tests__/
    ├── list-user-features.test.ts
    ├── build-user-manual-toc.test.ts
    └── inventory-roundtrip.test.ts
```

Generated files (`.feature-inventory.json`, `index.md`) are committed
to the repo so the manual is browsable on GitHub and diffs are
reviewable. The build script header documents this choice.

A one-line addition to `README.md` under "Where to go next" links to
`docs/user-manual/index.md`. A small note in `CLAUDE.md` documents the
`bun run docs:user-manual:*` scripts and the `pages-for:` front-matter
convention.

## The feature inventory

`scripts/list-user-features.ts` is pure TypeScript, runs with
`bun scripts/list-user-features.ts`, no npm dependencies. Uses
`node:fs/promises` and `node:path` plus targeted regex / lightweight
parsing of the few registry files.

### Categories scanned

| Category | Source | Example entry |
|---|---|---|
| Panels | `components/panels/*.tsx` (filename + optional title) | `chat`, `editor`, `library`, `canvas`, `workspaces`, `skills-tab`, `mcp-tab`, `notes-tab`, `pins-tab`, `url-bookmarks-tab`, `artifacts-tab`, `project-tasks-panel` |
| Sidebars | `components/sidebars/*.tsx` | `application`, `resources`, `tasks`, `conversation-item`, `document-item`, `prompt-item` |
| Slash commands | The slash-command registry (location TBD during plan; likely `lib/shared/slash-commands.ts` or `lib/client/commands/*`) | `/search`, `/summarize`, `/explain`, `/agents` |
| Settings | The UI / settings Zustand slice (likely `lib/client/hooks/store/slices/ui.ts` or a dedicated `settings` slice) | `theme`, `defaultModel`, `perConversationSystemPrompt` |
| Env vars | `.env.example` — extract var name + trailing comment | `AI_GATEWAY_API_KEY`, `TAVILY_API_KEY`, `MCP_ENCRYPTION_KEY`, `OLLAMA_BASE_URL`, `OPENROUTER_API_KEY`, `MINIMAX_CN_BASE_URL`, `MINIMAX_CN_API_KEY` |
| Keyboard shortcuts | A `shortcuts` module if it exists, otherwise a grep for keydown handlers with a hand-curated allowlist | `Enter` (send), `Shift+Enter` (newline), `Cmd+K` (command palette, if present) |
| MCP server lifecycle | `app/api/mcp/*` + `lib/server/mcp/*` route list | `add server`, `test connection`, `cloud-mode` toggle |
| Agent task types | The TaskEvent IR / task-type enum (likely `lib/shared/agent/events.ts`) | `start`, `cancel`, `resume` |

If a category's source file doesn't exist yet, the scanner emits an
empty array for that category and logs a stderr warning. It never
throws on missing sources — that keeps the build idempotent through
refactors.

### Output schema

```json
{
  "generatedAt": "2026-06-13T12:00:00Z",
  "schemaVersion": 1,
  "panels": [
    { "id": "chat", "title": "Chat", "sourceFile": "components/panels/chat.tsx" }
  ],
  "sidebars": [
    { "id": "application", "title": "Main navigation", "sourceFile": "components/sidebars/application.tsx" }
  ],
  "slashCommands": [
    { "id": "search", "command": "/search", "description": "Web search via Tavily", "sourceFile": "lib/shared/slash-commands.ts" }
  ],
  "settings": [
    { "id": "theme", "label": "Theme", "values": ["light", "dark", "system"], "sourceFile": "lib/client/hooks/store/slices/ui.ts" }
  ],
  "envVars": [
    { "id": "AI_GATEWAY_API_KEY", "description": "...", "required": true, "sourceFile": ".env.example" }
  ],
  "shortcuts": [
    { "id": "send-message", "keys": "Enter", "context": "chat composer" }
  ],
  "mcpServers": { "sourceFile": "app/api/mcp" },
  "agentTaskTypes": [
    { "id": "start", "description": "Begin a new agent run", "sourceFile": "lib/shared/agent/events.ts" }
  ]
}
```

`schemaVersion` is included so future shape changes can be detected by
`build-user-manual-toc.ts` with a clean error message.

### Robustness rules

- Unknown / new patterns → log to stderr with file:line, skip the
  entry. Never throw.
- Missing source file → empty array for that category, continue.
- Output is sorted and deterministically formatted so the file is
  diff-friendly across runs.
- `generatedAt` is the only field that changes between runs. It is
  emitted as a fixed-format UTC string (`2026-06-13T12:00:00Z`,
  seconds precision, `Z` suffix, no sub-second drift) so diffs are
  minimal — typically a one-line change at the top of the file. The
  `check` mode ignores `generatedAt` when diffing.

## The TOC builder

`scripts/build-user-manual-toc.ts` reads `.feature-inventory.json`
and writes `docs/user-manual/index.md`. It overwrites only that
single file; hand-written pages are untouched.

### The PAGE_MAP

A small static map at the top of the script (maintained by the
author) links each inventory id to the page that documents it:

```typescript
const PAGE_MAP: Record<string, string> = {
  "panel:chat": "02-chat.md",
  "panel:canvas": "09-canvas.md",
  "slash:search": "06-slash-commands.md",
  "setting:theme": "12-settings-and-theme.md",
  "env:AI_GATEWAY_API_KEY": "21-environment-variables.md",
  // ...
};
```

The `panel:`, `slash:`, `setting:`, `env:`, etc. prefixes disambiguate
inventory categories so a `chat` panel and a hypothetical `chat`
setting don't collide.

### The "Unmapped" section

Anything in the inventory that's not in `PAGE_MAP` shows up under a
clearly-marked section at the bottom of `index.md`:

```markdown
## Unmapped (action needed)

> ⚠ These inventory entries don't have a PAGE_MAP entry yet. Either
> add a page that documents them and wire it up, or move them to a
> "documented elsewhere" list in the map.

- `panel:foo` (components/panels/foo.tsx) — no page yet
- `env:NEW_THING` (.env.example) — no page yet
```

The author uses this section as the "what's left to document" list.

### Page front-matter (reverse check)

Each hand-written page has markdown comments at the top:

```markdown
<!-- pages-for: panel:chat, slash:search, slash:summarize -->
<!-- related: components/panels/chat.tsx, lib/server/chat/route.ts -->

# Chat
...
```

The build script reads these comments and uses them to:

1. **Reverse-check**: warn if a page claims an id that doesn't appear
   in the inventory. (Defensive against inventory shape changes — not
   a failure, just a stderr warning.)
2. **Cross-link footers**: the generated TOC can show "Pages claiming
   to cover `panel:chat`" so a reviewer can verify the wiring.

The comments are hidden from the GitHub-rendered page (they're HTML
comments inside Markdown).

### Generated TOC shape

```markdown
# Hummingbird — User Manual

> Generated TOC. Last inventory: 2026-06-13. Run `bun run docs:user-manual:build` to refresh.

## Part 1 — Using Hummingbird

- [Getting started](01-getting-started.md)
- [Chat](02-chat.md) — streaming, reasoning, attachments, suggested follow-ups
- ...

### Panels
| Panel | Page |
|---|---|
| Chat (`components/panels/chat.tsx`) | [Chat](02-chat.md) |
| Canvas (`components/panels/canvas.tsx`) | [Canvas](09-canvas.md) |
| ... |

### Slash commands
| Command | Page |
|---|---|
| `/search` | [Slash commands](06-slash-commands.md) |
| ... |

### Settings
| Setting | Page |
|---|---|
| Theme (`light` / `dark` / `system`) | [Settings & theme](12-settings-and-theme.md) |
| ... |

## Part 2 — Installing & Configuring

- [Installation](20-installation.md)
- [Environment variables](21-environment-variables.md)
- ...

### Environment variables
| Variable | Required | Page |
|---|---|---|
| `AI_GATEWAY_API_KEY` | yes (for real AI) | [Environment variables](21-environment-variables.md) |
| `MCP_ENCRYPTION_KEY` | only for cloud-mode MCP | [Encryption keys](25-encryption-keys.md) |
| ... |

## Unmapped (action needed)

> ⚠ ...

- `panel:foo` (components/panels/foo.tsx) — no page yet
```

The output is fully sorted, stable, and pinned by tests against
fixture inputs.

## Page template & content guidelines

A lightweight template. Authors fill only the sections that apply.

```markdown
<!-- pages-for: panel:chat, slash:search, slash:summarize -->
<!-- related: components/panels/chat.tsx, lib/server/chat/route.ts -->

# Chat

## What it is
One paragraph. What this surface is, in user terms.

## How to open it
How the user gets here (which sidebar tab, which keyboard shortcut).

## What you can do
Bulleted list of user actions, in plain language. No implementation details.

## Tips & gotchas
Common pitfalls, edge cases, "did you know" notes.

## Related
- [Slash commands](06-slash-commands.md)
- [Files & attachments](04-files-and-attachments.md)
```

### Style rules

1. **User voice, not developer voice.** "Click + to start a new chat"
   — not "clicking the + button dispatches `setActiveConversation(null)`."
   Code references go in the `related:` comment, not the body.
2. **Concrete first, conceptual second.** Show the action, then explain.
3. **No marketing.** No "powerful", "seamless", "intuitive". State what
   it does.
4. **Cross-link, don't duplicate.** If two features overlap, link to
   the canonical page.
5. **Part 1 never mentions env vars, source files, or deployment.**
   Part 2 assumes Bun + Docker + Postgres literacy.
6. **Troubleshooting lives in Part 2** (section 26). Part 1 may have
   a one-line "see [Troubleshooting](26-troubleshooting.md) if X"
   pointer.
7. **Code blocks in Part 1** are limited to slash-command examples.
   **Code blocks in Part 2** include env-var snippets and `bun run`
   commands.

## Build pipeline

Three new `package.json` scripts:

```json
{
  "docs:user-manual:build": "bun scripts/list-user-features.ts && bun scripts/build-user-manual-toc.ts",
  "docs:user-manual:check": "bun scripts/list-user-features.ts --check && bun scripts/build-user-manual-toc.ts --check",
  "docs:user-manual:roundtrip": "bun test scripts/__tests__/inventory-roundtrip.test.ts"
}
```

- **`build`** — default. Regenerates `.feature-inventory.json` and
  `index.md`.
- **`check`** — runs both scripts in `--check` mode: regenerate to a
  temp file, diff against the committed file, exit non-zero on drift.
  Available for future CI; not wired into `bun run check` in this
  project.
- **`roundtrip`** — runs the integration test that the manual +
  inventory agree.

### Author workflow

1. Add a new panel (e.g. `components/panels/foo.tsx`), wire it into
   the active-view store.
2. Run `bun run docs:user-manual:build`. The new panel appears in the
   "Unmapped" section of `index.md`.
3. Write `docs/user-manual/28-foo.md`, add
   `<!-- pages-for: panel:foo -->` at the top, add
   `"panel:foo": "28-foo.md"` to `PAGE_MAP` in
   `scripts/build-user-manual-toc.ts`.
4. Run `bun run docs:user-manual:build` again. The "Unmapped" section
   is now empty (for that id).
5. Commit page + inventory + TOC + `PAGE_MAP` change in the same PR
   as the feature.

## Test strategy

Three layers under `scripts/__tests__/`, run with `bun test`.

### 1. `list-user-features.test.ts`

- Fixture: a tiny `__fixtures__/repo/` subtree with sample components,
  a fake `.env.example`, a fake slash-commands file, a fake settings
  slice.
- Each test runs one scanner against the fixture and asserts on the
  parsed output.
- Tests pin the exact JSON output for the fixture (catches scanner
  regressions).

### 2. `build-user-manual-toc.test.ts`

- Fixture: a hand-written `.feature-inventory.json` + a `PAGE_MAP`
  excerpt.
- Test asserts the generated `index.md` is byte-identical to a pinned
  expected output.
- Cases:
  - (a) Fully-mapped inventory.
  - (b) Inventory with one unmapped entry → "Unmapped" section
    appears.
  - (c) Empty inventory → graceful empty TOC (no crash).

### 3. `inventory-roundtrip.test.ts`

Integration test that reads the real committed
`docs/user-manual/.feature-inventory.json` and walks the repo to
confirm:

- Every `sourceFile` referenced in the inventory still exists on disk.
- Every `pages-for:` id in every manual page is present in the
  inventory.
- The "Unmapped" list is empty.

Any violation fails the test. This is the canary — it's not wired
into `bun run check` (per the best-effort maintenance answer), but
running it explicitly via `bun run docs:user-manual:roundtrip` is
expected before tagging a release. Its failure mode is the signal
that prompts the author to update the manual.

## Rollout

Per-phase PRs, easy to review and revert.

### Phase 1 — Scaffolding

- Create `docs/user-manual/` with empty `.gitkeep`.
- Write `scripts/list-user-features.ts` with the four most important
  scanners (panels, sidebars, env vars, slash commands) + their unit
  tests.
- Write `scripts/build-user-manual-toc.ts` + its unit tests.
- Wire the three `package.json` scripts.
- Verify the empty-but-runnable pipeline by building once.

### Phase 2 — Part 1, core flows

- Write `01-getting-started.md`, `02-chat.md`, `03-editor.md`,
  `04-files-and-attachments.md`, `05-conversations-and-workspaces.md`,
  `12-settings-and-theme.md`, `13-keyboard-shortcuts.md`.
- Populate `PAGE_MAP` for the panels + settings these pages cover.
- Re-run build, confirm "Unmapped" shrinks.

### Phase 3 — Part 1, advanced features

- Write `06-slash-commands.md`, `07-skills-and-tools.md`,
  `08-agent-tasks.md`, `09-canvas.md`, `10-prompt-library.md`,
  `11-notes-and-bookmarks.md`.
- Populate `PAGE_MAP` for slash commands, MCP, agent task types.
- Add the remaining scanners (settings, shortcuts, MCP, agent task
  types) with their unit tests.

### Phase 4 — Part 2, self-hoster

- Write `20-installation.md`, `21-environment-variables.md`,
  `22-supabase-setup.md` (mostly pointers to existing
  `docs/SUPABASE_*.md`), `23-model-providers.md`,
  `24-mcp-server-config.md`, `25-encryption-keys.md`,
  `26-troubleshooting.md`, `27-architecture-overview.md`.
- Add the README.md link.

### Phase 5 — Sign-off

- Run `inventory-roundtrip` test, fix any drift.
- Self-review the full manual: broken cross-links, missing `pages-for`
  comments, contradictions with the live UI.
- Commit. Optionally tag a docs-only PR.

## Open questions for plan execution

- **Where exactly is the slash-command registry?** Likely
  `lib/shared/slash-commands.ts` or under `lib/client/commands/*`.
  Plan should confirm the location before writing the scanner.
- **Is there a dedicated settings slice, or is it folded into
  `ui.ts`?** Plan should confirm and pick the cleanest scanner
  source.
- **Where do keyboard shortcuts live?** If there's a `shortcuts.ts`
  module, scanner is trivial. If they're scattered, the scanner
  falls back to a grep with a hand-curated allowlist.
- **What's the source of truth for the `pages-for:` comment
  convention?** Not enforced today; relies on author discipline and
  reviewer attention. If discipline slips, this could become a future
  CI check.

## Out of scope (deferred)

- Translating the manual to other languages.
- Adding screenshots.
- Wiring the inventory into the in-app help system.
- Wiring `docs:user-manual:check` into CI.
- Auto-generating the prose of the manual pages themselves.
