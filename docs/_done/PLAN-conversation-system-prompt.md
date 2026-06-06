# Plan: Conversation-level system prompt

Status: **planning** — small, scoped slice. One migration + one new field across the
sync/store/api/UI surfaces. Lands behind no flag; existing conversations get an empty
prompt and behave identically.

## Why

The chat send pipeline already has a layered cascade in spirit — `lib/shared/agents/resolve.ts`'s
file comment documents it:

```
workspace
  → conversation       ← this tier has no field today
  → active persona
  → per-turn forced
  → per-turn muted
```

`Workspace.systemPrompt` and `Agent.systemPrompt` are both implemented; the **conversation**
slot was reserved but never given a field. Today every chat in a workspace shares the same
voice (workspace) and any per-turn override comes from selecting a persona (`/personas`),
which is a whole identity swap. There's no spot for "this thread is about Q4 planning;
assume that context" — long-lived instructions narrower than the workspace but broader
than a single turn.

Borrowed shape: ChatGPT Projects' "instructions" and Claude Projects' project-level custom
instructions, but scoped per-conversation rather than per-project (workspaces already own
the project-level layer).

## Composition order

Narrower scope wins, but **conversation prompt is additive across persona switches** —
swapping the voice doesn't blow away the thread context:

```
1. Global app guidance       (hard-coded; "Markdown, concise…")
2. Workspace.systemPrompt    (existing voice)
3. Conversation.systemPrompt (NEW; the thread's context)
4. Agent persona override    (REPLACES 2 when active; 3 stays)
5. Skill / MCP / attachment notes (appended; unchanged)
```

Rationale: the persona is "swap voice"; the conversation prompt is "stable thread context."
Persona ≠ context — keeping them orthogonal matches how a user actually thinks about
"switch to writing voice" vs "you're helping me with the Q4 plan." Claude Projects has the
same separation between project-instructions (persistent) and turn-level system prompts.

## Schema

`supabase/migrations/0021_conversation_system_prompt.sql`:

```sql
alter table conversations
  add column system_prompt text not null default '';
```

No RLS change — the existing per-user RLS already covers it. No backfill — the empty
default reproduces today's behaviour for every existing row.

## Types + store

- `lib/shared/types.ts` — add `systemPrompt: string` to `Conversation` (non-optional with a
  `""` default; matches `Agent.systemPrompt`).
- `lib/client/hooks/store/slices/conversations.ts` — add `setConversationSystemPrompt(id, prompt)` mutator.
- `lib/client/hooks/store/persist.ts` — bump `STORE_VERSION`; add a `runMigrations` step
  that defaults the new field on each conversation row. `persist.test.ts` will fail until
  the migration step lands.
- `lib/client/sync/handlers.ts` + `reconcile.ts` — extend the `conversations` diff
  to include `system_prompt`. The pure-diff helper test pattern in `handlers.*test.ts`
  already covers similar adds (the workspace fields).

## Resolver

`lib/shared/agents/resolve.ts` — extend `composeSystemPrompts` from a 2-tier signature to
3-tier:

```ts
export function composeSystemPrompts(
  workspaceSystemPrompt: string | undefined,
  conversationSystemPrompt: string | undefined, // NEW
  agentSystemPrompt: string,
): string | undefined
```

Composition rules:
- Trim each. Empties drop out.
- When persona is active (non-empty `agentSystemPrompt`), the **workspace** prompt drops
  out (the persona's voice replaces it); the **conversation** prompt stays.
- Join survivors with a blank line. Order: workspace/persona → conversation.

Tests: extend the existing resolver test file with the additive-on-persona-swap case +
each empty-combination matrix.

## API + chat route

- `lib/shared/api-schemas.ts` — `ChatRequestSchema` gains an optional `conversationSystemPrompt: z.string().max(20_000)`.
- `app/api/chat/route.ts` — pass it into `buildSystemPrompt` (now takes the third
  argument).
- `services/agent-py/src/agent_py/routers/chat.py` + `services/agent-ts/src/routes/chat.ts`
  — same: accept the field, thread it into `ChatConfig.system` via the composer. The
  three-backend wire shape stays identical.
- `lib/client/hooks/use-chat-send.ts` — read `activeConversation.systemPrompt`, pass it
  alongside `workspaceSystemPrompt` and `agentSystemPrompt` to `composeSystemPrompts()`
  and to the request body.

## UI surface

Minimal, low-friction. The chat header already has a row for the workspace persona / model
picker — add one item:

- **Inline pill** in the chat header: `Thread instructions` (or a 📝 icon when empty;
  filled icon when set). Click → opens a small dialog with a multi-line textarea + Save /
  Clear.
- **Empty by default** on new conversations. Do NOT inherit from the workspace — that would
  silently propagate edits the user already made at the workspace level, doubling them
  into the prompt. The conversation prompt is opt-in additive.
- **Character cap**: 20,000 chars (matches workspace `systemPrompt`). Show a counter when
  approaching it.
- **Persist on every keystroke?** No — save on blur or explicit Save, like the workspace
  prompt editor. The conversation row otherwise updates per-message; an extra debounced
  field would inflate `updatedAt` churn on every keystroke.

Out of scope for the first PR: a workspace-level "default conversation instructions"
setting, prompt templates, inheritance toggle. Land the field + composer first; layer those
on if usage justifies it.

## Tests

- **Resolver** — `lib/shared/agents/resolve.test.ts` — additive-on-persona-swap, empty
  matrix, trimming.
- **Composer end-to-end** — assert the chat route's `system` field on a fixture request
  with all three tiers populated.
- **Sync diff** — `handlers.conversation.test.ts` (the pattern from the workspace fields
  port).
- **Store migration** — `persist.test.ts` pins the new key + a `runMigrations` step.
- **API schema** — `api-schemas.test.ts` cap + truncation.

## Sequencing

One PR, in this commit order so each commit is reviewable:

1. Schema + types + store mutator + persist migration + sync diff (no behaviour change yet).
2. Resolver signature extension + tests.
3. Chat route + agent-py + agent-ts wiring; chat-send hook reads the field.
4. UI surface (header pill + dialog).

Codegen regen step lands with commit 3 (`bun run codegen:agent-types`).

## What's not in scope

- **Workspace-default conversation prompt** — listed in Future surfaces below; punt until
  someone asks.
- **Templates / library of canned thread instructions** — orthogonal; the prompts slice
  could power that later.
- **Inheritance toggle on conversation creation** — same; the cost is low if it lands later.
- **Cross-conversation memory** — separate plan (`PLAN-cross-conversation-memory.md`); this
  prompt is human-edited, not agent-edited.

## Future surfaces (post-ship, only if usage demands)

- "Apply to new conversations in this workspace" checkbox on the editor (effectively a
  workspace-default conversation prompt; lazy-copy on conv create).
- Generate from chat — a "summarise the past N messages into thread instructions for the
  next N" action, useful when a thread accumulates implicit context that the user wants to
  make explicit before clearing the message log.
- Surface in the conversation list — a small "📝" badge on conversations with a non-empty
  prompt, so the user can spot which threads have ad-hoc context attached.
