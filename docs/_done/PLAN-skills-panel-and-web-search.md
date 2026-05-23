# Plan: Skills panel + Web Search (first skill)

Status: **✅ shipped** (commits `7e0b9d7`, `60adf63`). Phase-2 items
originally listed as "cut from v1" — per-message overrides and
first-class persisted tool-call history — also shipped in `55064a8`.

## Goal & scope cuts

Build the **Skills surface** as a uniform concept so every future capability (image gen, code exec, page fetch, memory recall) plugs into the same plumbing. Web search is the v1 skill that proves the surface works.

**Cut from v1 to keep it shippable** *(status as of writing — see top
banner for what's shipped since)*:

- **Per-message overrides** — only conversation-scope on/off. Reconsider if it feels awkward in practice. **✅ shipped (`55064a8`)** as the chip × button.
- **Per-skill configuration UI** — web search uses sensible defaults (5 results, no domain filter); a "Configure…" pane is Phase 2. *(still deferred)*
- **First-class persisted tool-call history** — the live "Searching the web…" indicator streams during the response; for persistence we append a tiny markdown footer to the message (`> _Searched the web for "X", "Y"_`). No new column. Real tool-call records (a `tool_calls jsonb` on `messages`) are Phase 2. **✅ shipped (`55064a8`, migration `0008`)** — the markdown footer was replaced by `Message.toolCalls` + `messages.tool_calls jsonb`.

## Data model

### Cascade

Effective enabled for skill `S` on a conversation:

```
conversation.skill_prefs[S]  ??  workspace.skill_prefs[S]  ??  skill.default
```

### Schema (`supabase/migrations/0006_skills.sql`)

```sql
alter table workspaces add column if not exists skill_prefs jsonb not null default '{}';
alter table conversations add column if not exists skill_prefs jsonb not null default '{}';
```

JSONB rather than a join table because:

- Skill list is short (≤10 in foreseeable future)
- Schema-less keys mean adding a new skill = zero migration
- Cascade lookup is a single SELECT, no join

### Types

```ts
// lib/skills/types.ts
type SkillId = 'webSearch' | 'imageGen' | 'codeExec' | ...

interface Skill {
  id: SkillId
  name: string
  description: string
  icon: LucideIcon
  default: boolean
  // server-side: produces the AI SDK tool when this skill is on
}

type SkillPrefs = Partial<Record<SkillId, boolean>>
```

### Store

- `Workspace.skillPrefs?: SkillPrefs`
- `Conversation.skillPrefs?: SkillPrefs`
- Mutators:
  - `setWorkspaceSkillPref(workspaceId, skillId, value | null)` — null = clear / inherit
  - `setConversationSkillPref(conversationId, skillId, value | null)`
- Bump store version 8 → 9 with `{}` backfill
- Sync handlers emit `skill_prefs` on workspace/conversation upserts

## API surface

`POST /api/chat` already takes `{ messages, model, files, workspaceSystemPrompt }`. Add:

```ts
skills?: { id: SkillId }[]   // resolved list of enabled skill ids for this call
```

Inside the route:

1. For each enabled skill, register its AI SDK tool from `lib/skills/registry.ts`
2. Pass `tools: { ... }` and `experimental_toolChoice: 'auto'` to `streamText`
3. New SSE frame types streamed to the client:
   - `tool_call`  `{ id, name, args }` — fired when the model invokes a tool
   - `tool_result` `{ id, summary }` — fired when the tool returns (just a short summary string, not raw data, to keep the stream cheap)
4. After streaming completes, if any web-search tool was called, append a one-line markdown footer to the final message content so the record persists across reload.

## Web search tool

- Provider: **Tavily** (clean JSON API, $5 free monthly tier, ranked results with snippets). Env: `TAVILY_API_KEY`.
- Tool: `webSearch({ query: string })` → top 5 `{ title, url, snippet }`.
- The tool function lives in `lib/skills/web-search.ts`, called server-side from the chat route only — never exposed to the browser.
- When no `TAVILY_API_KEY` is set, the route silently omits the web-search tool from the model's tool list and adds a `🔧 Web search isn't configured` line in the system prompt note. Mirrors how AI Gateway falls back to mock today.

## UI surfaces

### 1. Skills tab in the right activity bar

Add a 4th icon (`Sparkles`) next to Files / Notes / Artifacts. Tab body lists every skill with:

- Icon + name + one-line description
- Toggle: **Off** / **On for this chat** / **On by default in this workspace** (three-state segmented control)
- Tiny "Inherits from workspace" hint when conversation pref is null

### 2. Active-skills chip row above the chat input

Renders only when ≥1 skill is effectively enabled for the active conversation. Each chip shows icon + name; clicking the chip opens the Skills tab.

### 3. In-response indicator (live + persisted)

**During stream**: the chat-message renders a small status block above the text:

> 🔍 Searching the web for "react server components benchmarks"…

When the tool returns it collapses to:

> 🔍 Searched the web · 5 results

**After stream / reload**: a single-line markdown footer appended to `Message.content`:

> _Searched the web: "react server components", "RSC perf"_

## Files

**New**

- `supabase/migrations/0006_skills.sql`
- `lib/skills/types.ts` — `Skill`, `SkillId`, `SkillPrefs`, cascade helper `resolveSkill(workspaceId, conversationId, skillId)`
- `lib/skills/registry.ts` — `SKILLS: Skill[]`, registers `webSearch`
- `lib/skills/web-search.ts` — Tavily client + AI SDK tool factory
- `components/panels/skills-tab.tsx` — list + three-state toggle component
- `components/skills/active-chips.tsx` — chip row above the input

**Modified**

- `lib/types.ts` — `Workspace.skillPrefs`, `Conversation.skillPrefs`
- `lib/hooks/use-store.ts` — slices + mutators + v8→v9 migration
- `lib/sync/handlers.ts` — include `skill_prefs` in workspace/conversation upserts
- `lib/supabase/types.ts` — add column to Row/Insert/Update
- `lib/api-schemas.ts` — add `skills` to `ChatRequestSchema`
- `app/api/chat/route.ts` — tool registration + new SSE frame types
- `components/panels/chat.tsx` — send `skills` in the request, parse new frames, ChipRow above input
- `components/panels/chat-message.tsx` — render `tool_call` / `tool_result` block above text
- `components/sidebars/resources.tsx` — add 4th tab entry
- `.env.example` — `TAVILY_API_KEY`

## Risks / tradeoffs

- ~~**Two-scope cascade only.** Per-message toggling is genuinely useful ("just this once, search the web") but doubles the UI complexity. If the chips row gets clicks asking for it, add in Phase 2.~~ **✅ shipped** as the chip × button in `55064a8`.
- **JSONB skill prefs** can't be FK-constrained against a fixed enum at the DB level. Trade-off accepted: TS keeps it honest in the app, and unknown keys just get ignored.
- **Tavily lock-in.** The provider lives behind a single file (`lib/skills/web-search.ts`) so swapping to Brave/Exa is a one-file change.
- ~~**Persisting tool-call history as a markdown footer is lossy** — you can't re-render the cute pill on reload, just the footer text. Acceptable for v1. Phase 2: a `tool_calls jsonb` column on `messages`.~~ **✅ shipped** in `55064a8` + migration `0008`. The pill renders the same on reload from `Message.toolCalls`.
- **No "stop using web search after N seconds"** — Tavily is fast (~500 ms) so we don't need a per-tool timeout in v1. Add if other skills (code exec, browser) prove slow.

## Verification

1. New conversation in a fresh workspace: chips row hidden (all skills default off). Skills tab shows Web Search with default-off three-state.
2. Toggle Web Search to **On for this chat**: chip appears above input.
3. Toggle to **On by default in this workspace**: a brand-new conversation in the same workspace has Web Search effectively on without a per-conversation override.
4. Ask "what's new in Next.js 17 since release?" with web search on — assistant message shows the live "Searching…" pill, then the result; footer line shows the query after stream ends.
5. Reload the conversation — message content keeps the footer; live pill is gone.
6. Without `TAVILY_API_KEY`: chip row still works, but a soft system-prompt note tells the model it can't actually search; model falls back to its training data and says so.
7. Cross-device: signing in on a second browser sees the same workspace-default and conversation overrides.

---

Roughly two PR-sized chunks:

1. The Skills surface + store + schema + cascade (no behavior change yet — just the plumbing and the panel).
2. The web search skill itself + chat-route tool plumbing + in-response indicator.
