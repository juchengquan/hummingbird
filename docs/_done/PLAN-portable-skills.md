# Plan: Portable Agent Skills (SKILL.md) + skill sharing

Status: **✅ shipped (v1)** — [#187](https://github.com/juchengquan/hummingbird/pull/187)
on 2026-06-11. SKILL.md format + storage + library listing +
prompt-builder injection (catalogue line per enabled skill, body
only when engaged). `userSkills` slice + `STORE_VERSION` 26 → 27
backfill. Bundled executable scripts are reopen / future work —
gated on the [code interpreter](../PLAN-code-interpreter.md) so the
sandbox security posture is in place first. Drafted in the
2026-06-09 market refresh. Origin: Anthropic Agent Skills — see
[Sources](#sources).

## Why

Hummingbird has two kinds of "skill" today, and they're code-locked:

- **Tool skills** — `ServerSkill`s in `lib/server/skills/`
  (`generateImage`, `webSearch`, `webFetch`, `searchFiles`). Each is a
  TypeScript object with a `buildTool()` + a `promptFragment()`, hard
  -wired into `SERVER_SKILLS`. Only a developer can add one.

Anthropic's **Agent Skills** format (`SKILL.md`: YAML front-matter —
name, description, *when to use* — plus a markdown body of instructions
and optional bundled scripts/resources) is now the portable,
cross-platform standard (Claude.ai, Claude Code, Agent SDK, Messages
API). It works by **progressive disclosure**: the short front-matter is
always available; the full body loads only when the skill is relevant.

Adopting it gives Hummingbird a *third* skill kind that's **data, not
code** — user-authored instruction skills that can be **imported** the
same way personas already are (`?import-agent=` base64url, PR #110).
That's a community/marketplace surface with near-zero protocol risk:
it's just files. It also composes with the [code interpreter](PLAN-code-interpreter.md)
— a skill's bundled scripts run there.

## Non-goals — what this is NOT

- **Not a rewrite of the tool-skill registry.** `SERVER_SKILLS` stays
  the execution layer for tool-backed skills. `SKILL.md` is a *portable
  authoring/exchange format* for **instruction** skills layered on top —
  not a replacement.
- **Not arbitrary code execution on import.** An imported `SKILL.md`
  injects *instructions* (a prompt fragment, progressively disclosed).
  Bundled scripts do **not** auto-run; they're only invokable via the
  sandboxed code interpreter, which has its own approval/budget gate.
- **Not a hosted marketplace.** v1 is import/export by URL + a local
  library, mirroring persona sharing. A central registry is later work.
- **Not multi-tenant sharing.** Per-user, like everything else today.

## Decisions to pin before code

1. **What a portable skill *is* in Hummingbird.** A stored record:
   `{ id, workspaceId, name, slug, description, whenToUse, body,
   resources?: SkillResource[], enabled }`. `description` + `whenToUse`
   are the always-available front-matter; `body` is the
   progressively-disclosed instructions. This maps 1:1 onto `SKILL.md`
   front-matter + body.
2. **How it activates (progressive disclosure).** The short
   `description`/`whenToUse` of every enabled skill is injected into the
   system prompt as a one-line catalogue. The **body** is injected only
   when the skill is engaged — either explicitly (the user enables it
   for the turn via the existing `/`-skill surface, or `#`-mentions it)
   or by a lightweight relevance gate. v1: **explicit engagement only**
   (no auto-relevance heuristic) — simplest, predictable.
3. **Storage.** A new `userSkills` Zustand slice + a `0023_user_skills`
   migration, mirroring the `agents` slice/table shape
   (`lib/client/hooks/store/slices/agents.ts` +
   `supabase/migrations/0020_agents.sql`) — workspace-scoped, soft
   -delete, own-your-rows RLS, `id` TEXT, sync round-trip. Reuses the
   established slice pattern wholesale.
4. **Share/import.** Mirror `lib/shared/agents/share.ts`
   (`encodeAgentShareToken` / `decodeAgentShareToken`, JSON →
   base64url) as `lib/shared/skills/share.ts`
   (`encodeSkillShareToken` / `decodeSkillShareToken`). A
   `components/skill-import-listener.tsx` watches `?import-skill=<token>`
   exactly like `components/agent-import-listener.tsx` — confirm modal,
   `createUserSkill`, `history.replaceState` to clear the param.
5. **Resources.** Front-matter can reference bundled files. v1 supports
   **text resources only** (templates, reference snippets) inlined into
   the share token under a size cap; binary/script resources are
   deferred to the code-interpreter integration.
6. **Relationship to the prompt library.** Prompts are
   click-to-insert snippets; skills are *standing instructions with
   metadata + activation rules*. Different enough to warrant their own
   slice — but the import/library UX is shared (see below).

## Shape — code surface

### Shared — the format adapter + share codec

- `lib/shared/skills/skill-md.ts` — pure parse/serialise:
  `parseSkillMd(text): UserSkill | { error }` (YAML front-matter +
  markdown body) and `toSkillMd(skill): string`. The interchange format.
- `lib/shared/skills/share.ts` — `encodeSkillShareToken(skill)` /
  `decodeSkillShareToken(token)`, base64url, schema-validated; mirrors
  `agents/share.ts`.
- `lib/shared/skills/types.ts` — `UserSkill`, `SkillResource`,
  `ShareableSkill` (stripped of ids/timestamps for sharing).

### Client — slice + import listener

- `lib/client/hooks/store/slices/user-skills.ts` — `UserSkillsSlice`
  (`createUserSkill`, `updateUserSkill`, `deleteUserSkill`,
  `restoreUserSkill`, `setSkillEnabled`) + `createUserSkillsSlice`,
  modelled on `agents.ts`. Selector `useWorkspaceUserSkills`.
- `components/skill-import-listener.tsx` — mounts near app root, watches
  `?import-skill=`, confirm + `createUserSkill` + clear param.

### Persist + sync

- `supabase/migrations/0023_user_skills.sql` — table + RLS (copy
  `0020_agents.sql`'s shape).
- Sync diff/reconcile/bulk-upload following the agents column codec;
  `STORE_VERSION` bump + a `runMigrations` step + the
  `store/persist.test.ts` key-set update (the frozen-shape contract).

### Prompt injection — `lib/server/`

- The chat route's system-prompt builder
  (`lib/server/chat/prompt-builders.ts`) gains a step: for each enabled
  user skill, inject its `description`/`whenToUse` one-liner into a
  "Available skills" catalogue; for each *engaged* skill, inject the
  `body`. Engagement is signalled on the wire (the request already
  carries forced/muted skill sets via `resolveEnabledSkills`; extend it
  to carry engaged `userSkillId`s).

### Library tab — listing + authoring

- `components/panels/library.tsx` (the existing Library tab) gains a
  **Skills** sub-view listing built-in tool skills (read-only) +
  user skills (editable), each with Enable / Edit / Share (copy
  `?import-skill=` URL) / Export `SKILL.md`. An "Import" action accepts
  a pasted `SKILL.md` or a share URL.

## Sequencing — one PR, three commits

1. **Commit 1 — format + storage.** `skill-md.ts` parse/serialise +
   `types.ts` + `share.ts` (all pure, well-tested); the `userSkills`
   slice; the `0023` migration + sync + persist-contract update. No UI
   wiring yet beyond store mutators.
2. **Commit 2 — prompt injection + engagement.** Catalogue + body
   injection in the prompt builder; engaged-skill signalling on the
   wire; the `/`-skill / `#`-mention surface lists user skills.
3. **Commit 3 — library UI + import/export.** The Skills sub-view, the
   import listener, share-URL copy, `SKILL.md` export.

## Tests

- **`parseSkillMd` / `toSkillMd` (commit 1)** — round-trip;
  missing-front-matter rejection; body-only; resource-cap rejection.
  ~8 cases, pure.
- **`encodeSkillShareToken` / `decodeSkillShareToken` (commit 1)** —
  round-trip + tamper/garbage → `null` (mirror the agents share tests).
- **Persist contract (commit 1)** — `store/persist.test.ts` updated for
  the new persisted key; migration step covered.
- **Prompt-builder injection (commit 2)** — catalogue line per enabled
  skill; body present only for engaged skills (pure builder test, the
  existing `prompt-builders.ts` test pattern).
- **Manual smoke (PR checklist)** — author a skill, enable it, engage it
  in a turn and confirm the body reaches the model; share URL imports on
  a second profile with MCP/resource stripping; export produces valid
  `SKILL.md`.

## Open questions before commit 1

1. **Auto-relevance vs explicit engagement.** Anthropic's format
   implies the model auto-loads a skill body when relevant.
   **Default: explicit engagement in v1** (deterministic, no
   surprise context bloat); add an opt-in relevance gate later.
2. **Conflict with `agents` (personas).** A persona already bundles a
   `systemPrompt` + skill scope. Is a portable skill just a smaller
   persona? **Default: keep them distinct — a persona is a *whole
   operating mode* (model + prompt + tool scope); a skill is a
   *reusable capability* a persona or a plain turn can engage.**
3. **Resource size cap in the share token.** **Default: 32 KB of
   inlined text resources; over that, export is file-based (download
   the `SKILL.md` + a resources folder) rather than a URL.**

## Reopen / future work

- **Bundled executable scripts** — runnable via the
  [code interpreter](PLAN-code-interpreter.md); gated by its
  approval/budget posture. Deferred until that ships.
- **Auto-relevance activation** — a cheap classifier or embedding match
  to load a skill body when the turn warrants it.
- **Central skill registry / marketplace** — a hosted index; needs the
  multi-tenant story first (same gate as the inspirations skip-list).
- **Agent-service parity** — teach `services/agent-py` + `agent-ts` to
  read the same catalogue/body injection so skills work on every
  backend.

## Sources

- [Anthropic — Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Agent Skills overview (docs)](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview)
- [anthropics/skills repo](https://github.com/anthropics/skills)
- [Agent Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills)
