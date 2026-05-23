/**
 * Pure parser for the `@` prompt-mention surface (prompts only —
 * skills use `/`, a physically-separate namespace; see the
 * two-symbol model in `docs/_done/PLAN-slash-commands.md`).
 *
 * An `@` mention expands a saved prompt template into the chat input:
 * typing `@persona` and picking it replaces the input with the
 * prompt's template (then the `{{variable}}` fill modal, if any).
 * Unlike a `/` skill slash, it is NOT a turn directive and nothing is
 * stripped at send time — by the time the user sends, the input is
 * just expanded text they can edit.
 *
 * Mirrors `lib/shared/skills/slash-parser.ts` but takes the prompt
 * list as an argument (prompts are dynamic user data, not a static
 * registry). No React, no I/O — fully unit-testable.
 */

import type { Prompt } from "@/shared/types"

/** Max rows surfaced in the autocomplete. Prompts are unbounded user
 *  data; cap so a big library doesn't render a giant menu. */
export const MAX_MENTION_MATCHES = 8

/**
 * Whether the input is in the "typing an `@` mention" state — leading
 * `@`, caret still inside the first token (no whitespace yet). Drives
 * the autocomplete's open/closed state. Mirrors
 * `isTypingSlashCommand`: the `@` must be the very first character, and
 * the menu closes once any whitespace is typed.
 */
export function isTypingPromptMention(text: string): boolean {
  if (!text.startsWith("@")) return false
  return !/\s/.test(text)
}

/**
 * Autocomplete matches for the partial token after the `@`. `partial`
 * is the text between the `@` and the caret (without the `@`).
 *
 * Ranking: slug-prefix matches first (the precise hit the user is
 * typing toward), then name-substring matches (discovery — users
 * think in names, not slugs). Soft-deleted prompts are excluded.
 * Empty partial returns every live prompt. Capped at
 * `MAX_MENTION_MATCHES`.
 */
export function matchPromptMentions(
  partial: string,
  prompts: Prompt[]
): Prompt[] {
  const live = prompts.filter((p) => !p.deletedAt)
  const needle = partial.toLowerCase()
  if (!needle) return live.slice(0, MAX_MENTION_MATCHES)

  const slugPrefix: Prompt[] = []
  const nameMatch: Prompt[] = []
  for (const p of live) {
    if (p.slug.toLowerCase().startsWith(needle)) slugPrefix.push(p)
    else if (p.name.toLowerCase().includes(needle)) nameMatch.push(p)
  }
  return [...slugPrefix, ...nameMatch].slice(0, MAX_MENTION_MATCHES)
}

/**
 * Resolve a complete `@slug` token to its prompt. Used if we ever
 * parse a typed-out mention at send time; exact, case-insensitive
 * slug match against live prompts. Returns null when nothing matches.
 */
export function findPromptBySlug(
  slug: string,
  prompts: Prompt[]
): Prompt | null {
  const s = slug.toLowerCase()
  return prompts.find((p) => !p.deletedAt && p.slug.toLowerCase() === s) ?? null
}
