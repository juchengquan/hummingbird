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
 * Combine the persona's system prompt with the workspace's, mirroring
 * how `buildTaskSystemPrompt` already trims + concatenates. Trims and
 * joins with a blank line. Either side may be empty.
 */
export function composeSystemPrompts(
  workspaceSystemPrompt: string | undefined,
  agentSystemPrompt: string
): string | undefined {
  const w = workspaceSystemPrompt?.trim() ?? ""
  const a = agentSystemPrompt.trim()
  if (!w && !a) return undefined
  if (!w) return a
  if (!a) return w
  return `${w}\n\n${a}`
}
