# Plan: Custom agents / personas

Status: 📐 planning. Promoted from
[`SURVEY-market-2026.md` §4.4](SURVEY-market-2026.md). Three phases;
Phase 1 is the smallest viable surface (CRUD + slash invocation),
Phases 2–3 layer on MCP allow-listing + share-by-URL and project-mode
integration.

## What "personas" are, in plain language

A persona is a **saved bundle** of "how this AI should behave for a
specific kind of task." Each persona answers four questions:

1. **Who is it?** A name + system prompt — *"You are a code reviewer
   who flags security bugs and style issues; explain in 1–2 sentences
   each."*
2. **What model does it run on?** Maybe `claude-sonnet-4-6` for speed,
   `claude-opus-4-7` for hard reasoning, a local Minimax for cheap
   turns.
3. **What can it touch?** A list of allowed skills (web search? image
   gen? `searchFiles`?) and allowed MCP servers (GitHub MCP? Linear
   MCP?). Tools not in the list are off-limits for this persona.
4. **What does it know?** Optionally a knowledge scope — *"only the
   files in this workspace"*, or *"only files tagged with `policy`"*.
   (Phase 3+.)

The user invokes the persona with `/<persona-slug>` or pins it to a
conversation. From that point on, replies follow the recipe.

## How the big assistants do this

The labels differ, the idea is the same:

| Product | Name | What it bundles |
|---|---|---|
| ChatGPT | **GPTs** | Instructions + files + actions + sharable URL + marketplace |
| Claude.ai | **Projects** + **Skills** | Projects = knowledge scope + instructions; Skills = reusable per-task playbooks the model auto-picks |
| Gemini | **Gems** | Instructions + (paid) attached files |
| Perplexity | **Spaces** | Instructions + files + collaborative team scope |
| LobeChat | **Agents** | Provider-specific personas with knowledge base |
| TypingMind | **Project folders / agents** | Persona + KB + plugins per folder |

Common pattern across all of them: a **named, reusable, persona-shaped
configuration** the user picks instead of starting from a blank prompt
each time.

## Why Humm is well-positioned

Three of the four persona ingredients already exist as project
primitives:

| Persona ingredient | Already in Humm |
|---|---|
| Reusable text + variables | Prompt library (`prompts/expand.ts`, `prompts/mention-parser.ts`) + workspace `systemPrompt` |
| Per-turn skill forcing | `/<skill>` slash trigger + `resolveEnabledSkills` cascade |
| Tool allow-listing (server-side) | MCP cloud-mode + `requireApprovalFor` policy |
| Model pinning | Workspace `defaultModel` + chat-input picker |

What's missing is the **glue object that bundles them under a name**.
That's why this is the lowest-effort distinctive bet on the survey
shortlist — most of the cost is the schema + sync + a dialog, not new
behaviour.

## User flow sketch

```
Sidebar → Personas group (new) → New persona
        │
        ▼
1.  Name: `code-reviewer`, slug auto-derived.
2.  System prompt: "You review pull-request diffs…"
3.  Model: pick from the existing model picker (defaults to workspace's).
4.  Allowed skills: multi-select chips (webSearch, webFetch, searchFiles, imageGen).
5.  Allowed MCP servers: multi-select chips (the workspace's cloud-mode servers).
6.  Save.

In the chat:
- Type `/code-reviewer review this diff` → persona's recipe applies for the turn.
- OR pin via the chat header — every reply uses the persona until unpinned.
- Slash-help dialog (`/help`) lists personas alongside skills + modes.

In a research-mode task:
- `/code-reviewer review the Q3 audit findings` runs as a research task
  (existing /<mode> behaviour) with the persona's model + skills + MCP
  scope layered on.

Sharing:
- "Copy share URL" on a persona → URL contains a base64-encoded JSON blob.
- Recipient opens it in their app → "Import persona into workspace?"
  modal → click Import. Personas are pure config; no remote dependency.
```

## Design — schema + touchpoints

### The persona object

```ts
export interface Agent {
  id: string                  // text, matches the in-store uuid()
  workspaceId: string         // workspace-scoped (sync convention)
  name: string                // user-facing label
  slug: string                // /<slug> trigger; unique per (workspace, !deletedAt)
  systemPrompt: string        // free-text; appended after workspace's systemPrompt
  modelId?: string            // optional override; falls back to workspace defaultModel
  allowedSkillIds: SkillId[]  // empty = "allow nothing extra"; presence of an id =
                              // force-enable for the turn the persona is active
  allowedMcpServerIds: string[]  // empty = "no MCP for this persona";
                                 // present = only these MCP servers
                                 // are wired in for the turn
  icon?: string               // optional lucide name; defaults to UserCircle
  pinned?: boolean            // sticky in the sidebar listing
  createdAt: Date
  updatedAt: Date
  deletedAt?: Date            // soft-delete (sync handler convention)
}
```

Naming the type **`Agent`** instead of `Persona` matches the survey
language and project precedent (the existing `tasks` table is for
"agent runs"). Sync rows use `agents` to match table-name plurals.

### Concrete touchpoints (Phase 1)

| Layer | Add / change |
|---|---|
| Migration | `0020_agents.sql` — workspace-scoped table; same four-policy RLS pattern as `0017_prompts_workspace.sql` |
| Types | `Agent` interface in `lib/shared/types.ts` (alongside `Prompt`) |
| Store slice | `agents`, `createAgent`, `updateAgent`, `deleteAgent`, `setActiveAgent` in `lib/client/hooks/use-store.ts` |
| Sync | `diffAgents` + reconcile in the existing sync layer (mirror `diffPrompts`) |
| Slash surface | New fourth kind `agent` alongside `skill` / `command` / `task_mode` in `lib/shared/slash-resolver.ts` |
| Resolver | `lib/shared/agents/resolve.ts` (pure) — given an `Agent` + cascade context, produce the effective `{ systemPrompt, modelId, forcedSkillIds, allowedMcpServerIds }` |
| Chat dispatch | In `components/panels/chat.tsx`, when the slash resolves to `kind: 'agent'`, layer the resolved persona over the existing send pipeline |
| Sidebar | New "Personas" group component in `components/sidebars/application.tsx` (mirrors the existing Prompts group) |
| Editor dialog | `components/panels/agent-editor-dialog.tsx` (mirrors `prompt-editor-dialog.tsx`) |
| Help dialog | New "Personas" section in `slash-help-dialog.tsx` |

The MCP allow-list is best enforced by passing only the allowed server
IDs into the tool builder in `lib/server/agent/worker.ts` /
`lib/server/mcp/load-servers.ts`. Cleaner than retro-fitting cascade
machinery for "force-disable."

### How invocation composes with what's already there

The chat send pipeline already handles a stack of overrides:

```
workspace defaults
  → conversation overrides
  → per-turn forced (slash, "Run as task" toggle)
  → per-turn muted (the chip × button)
```

A persona slots in **between conversation overrides and per-turn
forced** as a *persona layer*:

```
workspace
  → conversation
  → active persona (system prompt, model, allowed skills, allowed MCP)
  → per-turn forced
  → per-turn muted
```

This means `/<persona> /research <goal>` reads naturally: the
research mode is the per-turn forced layer, the persona is the
recipe layer underneath. Chains compose without invasive rework.

### Sharing — pure JSON, no remote

A persona is just config; nothing else needs to travel. The share URL
encodes `{ name, slug, systemPrompt, modelId, allowedSkillIds,
allowedMcpServerIds }` as base64 JSON in a fragment:

```
https://humm.app/?import-agent=<base64url(JSON)>
```

The recipient's app sees the param on load, shows an Import modal, and
on accept calls `createAgent` against their active workspace. MCP
server IDs are *names*, not foreign keys to the sharer's data — if the
recipient doesn't have a server with the same id the import warns and
drops that allow-list entry.

## Phasing

### Phase 1 — Schema + CRUD + slash invocation (~250 lines)

- `0020_agents.sql` migration + types regen.
- `Agent` type in `lib/shared/types.ts`.
- Store slice (`agents`, CRUD mutators).
- Sync handler (`diffAgents` mirroring `diffPrompts`).
- New `agent` kind in `slash-resolver.ts` + `matchSlashMenu`.
- `lib/shared/agents/resolve.ts` (pure) — produces `{ systemPrompt,
  modelId, forcedSkillIds }` for a persona.
- Chat dispatch wires the resolved persona into the send pipeline.
- Personas group in the sidebar + minimal editor dialog (name, slug,
  prompt, model, skills checklist).
- Slash-help dialog gains a Personas section.

Phase 1 ships persona reuse end-to-end without MCP scoping or sharing.
MCP servers behave as they do today (cascade through workspace).

### Phase 2 — MCP allow-list + share-by-URL (~150 lines)

- Multi-select for MCP servers in the editor dialog.
- Worker reads `agent.allowedMcpServerIds` and passes only those
  through `loadEffectiveMcpServers`.
- Chat route mirrors the server-side filter.
- "Copy share URL" button on the persona row.
- Import modal on `?import-agent=` URL param.

### Phase 3 — Project-mode integration (~80 lines)

- Optional `agentId` on `ProjectTask` (Kanban card).
- "Run as task" launches with the card's persona pre-applied (model,
  skills, prompt).
- Workspace detail sheet exposes a "default persona for new tasks"
  setting.

## Tradeoffs / open questions

- **One persona vs many per conversation?** Phase 1 ships one
  active-at-a-time (the persona "owns" the conversation while pinned).
  Multiple at once is conceptually unclear and not on a critical path.
- **Personas vs prompts.** Prompts insert text into the user message;
  personas reshape the whole turn. They overlap for power users.
  Phase 1 keeps them separate. A future "Convert this prompt into a
  persona" affordance is cheap.
- **Skill allow-list semantics.** Empty `allowedSkillIds` could mean
  "no skills" or "inherit from cascade." Going with **explicit list,
  no inheritance** — predictable; the user picks exactly what's
  available. A future "Inherit + add" mode could be a per-persona
  toggle.
- **MCP allow-list portability across users.** Shared personas
  reference MCP server IDs the recipient may not have. Phase 2's
  import modal warns + drops missing entries; the persona still
  imports, just with a thinner tool list.
- **Per-turn editing.** Users sometimes want "this persona, but turn
  off web search just this turn." The existing per-turn chip mute
  surface handles this naturally — mute beats persona-force, same
  rule as mute-beats-slash-force today.
- **Sync — workspace-scoped vs user-scoped.** Following
  `0017_prompts_workspace.sql`: workspace-scoped. A "copy persona to
  another workspace" affordance is a small follow-up if cross-
  workspace use shows up.
- **Naming collision risk.** Personas, MCP servers, prompts all live
  in the `/<token>` namespace today (post-survey, only personas
  would be new). Slug uniqueness check during create + a slash-help
  surface that shows all four kinds prevents user confusion.
- **Anonymous users.** Personas are stored in the same store slice as
  prompts; anonymous users get local-only personas, mirroring the
  prompts pattern. No sync until sign-in.

## Relationship to other plans

- **Prompts** (`_done/PLAN-prompt-library.md`) — closest sibling. The
  schema + sync + editor dialog patterns transfer directly.
- **`PLAN-deep-research.md`** — research mode is a *task mode*;
  personas are a *recipe layer*. They compose: `/code-reviewer
  /research <goal>` reads as "run a research task using the code-
  reviewer's model + skills + prompt." Worth noting in the research
  plan once this lands.
- **`SURVEY-market-2026.md` §4.5** (Subagents + Live agent visibility)
  — once subagents exist, a parent task can spawn a *persona*
  subagent rather than configuring one ad-hoc. Persona + subagent
  compose cleanly.
- **`SURVEY-market-2026.md` §4.3** (Outbound MCP server) — orthogonal.
  Personas are about which MCP servers a turn *can call*; outbound
  MCP is about exposing Humm itself as an MCP server. Both can ship
  independently.

## Recommendation / next step

Ship **Phase 1** as the first PR. It validates the persona shape end-
to-end on the smallest possible surface (schema + store + slash + a
dialog) and yields a usable feature: a workspace accumulates named
recipes the user reaches for the same way they reach for prompts
today, except the recipe brings model + tools + scope along for the
ride.

Phase 2 (MCP scoping + share-by-URL) is the natural follow-on; it's
the smallest delta that turns "useful for the user themselves" into
"useful for a team." Phase 3 (project-mode integration) only makes
sense once Kanban cards are a heavy user surface.
