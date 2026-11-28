/**
 * Folds enabled user skills into the system prompt (the client-side v1
 * activation path — no server change). The enabled, non-deleted skills
 * for the active workspace contribute their bodies under a small header,
 * appended after the composed workspace/conversation/persona prompt.
 * Pure — no I/O. See `docs/PLAN-portable-skills.md`.
 */

import type { UserSkill } from "./user-skill-types"

/** Build the instruction block for a workspace's enabled skills, or
 *  `undefined` when none are enabled. Each skill contributes a labelled
 *  section so the model can tell them apart. */
export function composeUserSkillInstructions(
  skills: UserSkill[],
  workspaceId: string | null | undefined
): string | undefined {
  if (!workspaceId) return undefined
  const active = skills.filter(
    (s) => s.workspaceId === workspaceId && s.enabled && !s.deletedAt
  )
  if (active.length === 0) return undefined
  const sections = active.map((s) => {
    const body = s.body.trim()
    return body ? `### ${s.name}\n${body}` : null
  })
  const joined = sections.filter(Boolean).join("\n\n")
  if (!joined) return undefined
  return `## Active skills\n\n${joined}`
}

/** Append the enabled-skill instruction block to a base system prompt.
 *  Either side may be empty/undefined; returns `undefined` only when
 *  both are. Used at the chat-send call site to layer skills on top of
 *  the workspace/conversation/persona composition. */
export function withUserSkillInstructions(
  base: string | undefined,
  skills: UserSkill[],
  workspaceId: string | null | undefined
): string | undefined {
  const block = composeUserSkillInstructions(skills, workspaceId)
  const pieces = [base?.trim(), block].filter(Boolean) as string[]
  if (pieces.length === 0) return undefined
  return pieces.join("\n\n")
}
