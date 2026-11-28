/**
 * Portable Agent Skills (SKILL.md) — shared types. v1 is **client-side
 * only + local-only** (no server prompt-injection, no Supabase sync); a
 * user skill is plain instructions the user authors or imports, toggled
 * on per workspace. When enabled, its `body` is folded into the composed
 * system prompt for that workspace's turns. See
 * `docs/PLAN-portable-skills.md`.
 *
 * Deliberately distinct from:
 *   - **personas** (`Agent`) — a whole operating mode (model + prompt +
 *     tool scope);
 *   - **prompts** — click-to-insert snippets;
 *   - built-in tool **skills** (`ServerSkill`) — code-backed tools.
 * A user skill is *standing instructions with metadata*.
 *
 * v1 carries no slug (engagement is the enabled toggle, not `/<slug>`),
 * no bundled resources, and no auto-relevance — all deferred.
 */
export interface UserSkill {
  id: string
  workspaceId: string
  /** Short human label. */
  name: string
  /** One-line summary of what the skill does. */
  description: string
  /** One-line "use this when…" hint. Informational in v1 (no
   *  auto-relevance); surfaced in the management UI. */
  whenToUse: string
  /** The instruction body (markdown). Folded into the system prompt
   *  when the skill is enabled. */
  body: string
  /** When true, the body is injected into this workspace's turns. */
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  /** Soft-delete marker (mirrors the agents slice). */
  deletedAt?: Date
}

/** The subset that travels in a share link — no ids, timestamps,
 *  workspace, or enabled flag. The recipient re-derives those. */
export interface ShareableUserSkill {
  name: string
  description: string
  whenToUse: string
  body: string
}
