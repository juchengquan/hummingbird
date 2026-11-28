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
 * Combine the four system-prompt tiers in the chat-send cascade —
 * account custom instructions (the always-on base), workspace voice,
 * conversation context, and active persona — per
 * `docs/PLAN-conversation-system-prompt.md` and the account-level
 * custom-instructions plan. Each input may be empty or undefined;
 * empties are trimmed out.
 *
 * Tier order: account base → workspace/persona voice → conversation
 * context. The composed string has two sections, blank-line separated:
 *   - **Voice** (how to respond): account *style* first, then the
 *     persona-or-workspace voice that can refine it.
 *   - **Context** (who/what): account *about* first, then the
 *     conversation's stable thread context.
 *
 * Composition rules:
 *   - The account base (style + about) **always applies** — it is
 *     never dropped, including when a persona is active.
 *   - When the persona is active (non-empty `agentSystemPrompt`),
 *     the *workspace* prompt drops out. The persona's voice replaces
 *     the workspace's; the account base and conversation context stay.
 *   - Conversation prompt is **additive** — it represents stable
 *     thread context (what this chat is about), orthogonal to the
 *     voice. It survives persona switching.
 *   - Order in the joined string is voice → context, blank-line
 *     separated, so the model reads "respond like <voice>" first, then
 *     "we're working on <context>."
 */
export function composeSystemPrompts(
  customInstructionsStyle: string | undefined,
  customInstructionsAbout: string | undefined,
  workspaceSystemPrompt: string | undefined,
  conversationSystemPrompt: string | undefined,
  agentSystemPrompt: string,
): string | undefined {
  const cs = customInstructionsStyle?.trim() ?? ""
  const ca = customInstructionsAbout?.trim() ?? ""
  const w = workspaceSystemPrompt?.trim() ?? ""
  const c = conversationSystemPrompt?.trim() ?? ""
  const a = agentSystemPrompt.trim()
  // Account instructions are the always-on base. Voice = how-to-respond
  // (account style first, then persona-or-workspace which can refine it).
  // Context = who/what (account about first, then conversation context).
  // Persona still replaces the *workspace* voice; the account base and
  // conversation context are never dropped.
  const voice = [cs, a || w].filter(Boolean).join("\n\n")
  const context = [ca, c].filter(Boolean).join("\n\n")
  const pieces = [voice, context].filter(Boolean)
  if (pieces.length === 0) return undefined
  return pieces.join("\n\n")
}
