/**
 * Pure parser for the `/<persona-slug> …` slash directive
 * (`PLAN-custom-agents.md`). Unlike skill / command / task-mode
 * triggers (which are compile-time registries), persona slugs are
 * user-supplied — the dispatcher passes the current workspace's
 * persona list in.
 *
 * No React, no I/O. The chat panel reads the parse result, applies the
 * persona's resolution, and sends.
 */

import type { Agent } from "../types"

export interface ParsedAgentSlash {
  agent: Agent
  trigger: string
  /** Message body with `/<slug> ` stripped. May be empty (the user
   *  hasn't typed anything after the slug). */
  remainder: string
}

/**
 * Extract a leading `/<slug> ` directive against the supplied list of
 * (non-deleted) personas. Same shape as the skill slash parser:
 *
 *   - Must start with `/`.
 *   - Slug is the first run of letters / digits / dashes / underscores.
 *   - Whitespace AFTER the slug is required (`/code-reviewer` alone is
 *     "still typing").
 *   - Body after the space may be empty — callers decide whether to
 *     send-blank or wait.
 *
 * Case-insensitive on the slug. Returns null when no token matches.
 */
export function parseAgentSlash(
  text: string,
  agents: Agent[]
): ParsedAgentSlash | null {
  if (!text.startsWith("/")) return null
  // Persona slugs are typically kebab-case but can include digits /
  // underscores. Allow a slightly wider charset than skills do.
  const m = text.match(/^\/([a-zA-Z0-9_-]+)(\s+)([\s\S]*)$/)
  if (!m) return null
  const slug = m[1].toLowerCase()
  const agent = agents.find(
    (a) => !a.deletedAt && a.slug.toLowerCase() === slug
  )
  if (!agent) return null
  return {
    agent,
    trigger: slug,
    remainder: m[3].trimStart(),
  }
}

/**
 * Autocomplete matches for the partial token typed after `/`. Empty
 * partial returns every active persona; otherwise prefix-matches on
 * the slug. Deleted personas are filtered out.
 */
export function matchAgentSlugs(partial: string, agents: Agent[]): Agent[] {
  const needle = partial.toLowerCase()
  const active = agents.filter((a) => !a.deletedAt)
  if (!needle) return active
  return active.filter((a) => a.slug.toLowerCase().startsWith(needle))
}
