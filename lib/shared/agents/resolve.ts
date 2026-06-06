/**
 * Pure resolver for custom agents / personas
 * (`PLAN-custom-agents.md`). Given a stored `Agent`, produce the
 * effective overrides the chat send pipeline layers on top of the
 * workspace + conversation cascade.
 *
 * The cascade slot is between conversation overrides and per-turn
 * forced (slash skill triggers, "Run as task"):
 *
 *   workspace
 *     → conversation
 *     → active persona  (this resolver)
 *     → per-turn forced
 *     → per-turn muted
 *
 * Pure: no I/O, no React. Both the chat panel and the project-mode
 * "Run as task" action call it.
 */

import type { Agent } from "../types"

export interface ResolvedAgent {
  /** Persona's system prompt — empty string when the persona didn't
   *  set one. The caller appends after the workspace's `systemPrompt`. */
  systemPrompt: string
  /** Model override, or `undefined` if the persona didn't pin one. */
  modelId?: string
  /** Skills the persona allows for this turn. Combine with the chat's
   *  `forcedSkillIds` arg before the `resolveEnabledSkills` cascade. */
  forcedSkillIds: string[]
  /** MCP server ids the persona allows for this turn. Empty array means
   *  "no MCP." `null` means "no restriction — pass through whatever the
   *  workspace cascade resolves." Distinct from empty so a persona can
   *  intentionally block all MCP. */
  allowedMcpServerIds: string[] | null
}

/**
 * Resolve a persona's contribution to the turn. `null` agent returns
 * a no-op resolution — callers can unconditionally call this and
 * concatenate without branching.
 */
export function resolveAgent(agent: Agent | null | undefined): ResolvedAgent {
  if (!agent || agent.deletedAt) {
    return {
      systemPrompt: "",
      forcedSkillIds: [],
      allowedMcpServerIds: null,
    }
  }
  return {
    systemPrompt: agent.systemPrompt ?? "",
    modelId: agent.modelId,
    forcedSkillIds: [...agent.allowedSkillIds],
    // Empty arrays are meaningful — "no MCP allowed." `null` would mean
    // "no restriction"; today we don't have a way to express that in the
    // stored shape (an empty array IS the explicit-allow-list semantics),
    // so always return the array. A future "inherit from cascade" toggle
    // could flip this to null.
    allowedMcpServerIds: [...agent.allowedMcpServerIds],
  }
}

/**
 * Combine the three system-prompt tiers in the chat-send cascade —
 * workspace voice, conversation context, and active persona — per
 * `docs/PLAN-conversation-system-prompt.md`. Each input may be empty
 * or undefined; empties are trimmed out.
 *
 * Composition rules:
 *   - When the persona is active (non-empty `agentSystemPrompt`),
 *     the workspace prompt drops out. The persona's voice replaces
 *     the workspace's; the conversation prompt stays.
 *   - Conversation prompt is **additive** — it represents stable
 *     thread context (what this chat is about), orthogonal to the
 *     voice (workspace or persona). It survives persona switching.
 *   - Order in the joined string is voice → context, blank-line
 *     separated, so the model reads "you are <voice>" first, then
 *     "we're working on <context>."
 */
export function composeSystemPrompts(
  workspaceSystemPrompt: string | undefined,
  conversationSystemPrompt: string | undefined,
  agentSystemPrompt: string,
): string | undefined {
  const w = workspaceSystemPrompt?.trim() ?? ""
  const c = conversationSystemPrompt?.trim() ?? ""
  const a = agentSystemPrompt.trim()
  // Persona replaces workspace voice when active; conversation
  // context stays regardless.
  const voice = a || w
  const pieces = [voice, c].filter(Boolean)
  if (pieces.length === 0) return undefined
  return pieces.join("\n\n")
}
