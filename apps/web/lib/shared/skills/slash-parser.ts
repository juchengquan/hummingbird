/**
 * Pure parser for the `/` slash-command surface (skills only — prompt
 * templates use `@`, a physically-separate namespace; see
 * `docs/PLAN-slash-commands.md`).
 *
 * A skill slash is a turn-level directive: typing `/search latest news`
 * forces the `webSearch` skill on for that one send, regardless of the
 * workspace/conversation cascade. The parser is used in two places:
 *
 *   1. The chat panel's send path — to detect a leading slash, resolve
 *      it to a skill id, and strip the `/trigger ` prefix from the
 *      message that's actually sent.
 *   2. The autocomplete component — to decide what to show as the user
 *      types and to complete a chosen trigger.
 *
 * No React, no I/O — fully unit-testable.
 */

import { SKILLS } from "./registry"
import type { SkillDescriptor, SkillId } from "./types"

export interface SlashTriggerEntry {
  skillId: SkillId
  /** Canonical (first) trigger — what the autocomplete shows. */
  trigger: string
  /** All accepted tokens (canonical + aliases). */
  aliases: string[]
  skill: SkillDescriptor
}

/** Build the flat trigger table from the skill registry. Canonical
 *  trigger first; skills without `slashTriggers` are omitted. */
export function listSlashTriggers(): SlashTriggerEntry[] {
  const out: SlashTriggerEntry[] = []
  for (const skill of SKILLS) {
    const triggers = skill.slashTriggers
    if (!triggers || triggers.length === 0) continue
    out.push({
      skillId: skill.id,
      trigger: triggers[0],
      aliases: triggers,
      skill,
    })
  }
  return out
}

/** Lowercased alias → entry, for O(1) resolution. */
function aliasMap(): Map<string, SlashTriggerEntry> {
  const m = new Map<string, SlashTriggerEntry>()
  for (const e of listSlashTriggers()) {
    for (const a of e.aliases) m.set(a.toLowerCase(), e)
  }
  return m
}

export interface ParsedSlash {
  skillId: SkillId
  /** The matched token, lowercased (e.g. "search"). */
  trigger: string
  /** Message body with the `/trigger` + the single following space
   *  stripped. May be empty. */
  remainder: string
}

/**
 * Extract a leading `/trigger ` directive from `text`.
 *
 * Returns null when:
 *   - the text doesn't start with `/` (leading whitespace disqualifies —
 *     the slash must be the very first character),
 *   - the first token isn't a registered trigger/alias,
 *   - there's no whitespace after the trigger (so `/searchy` is a typo,
 *     not the `/search` command; `/search` alone with no trailing space
 *     is treated as "still typing", i.e. null).
 *
 * Case-insensitive on the trigger; the remainder is preserved verbatim
 * (only the single delimiting space after the trigger is consumed, then
 * leading whitespace on the body is trimmed).
 */
export function parseSlashCommand(text: string): ParsedSlash | null {
  if (!text.startsWith("/")) return null
  // `/(token)(whitespace)(rest)` — token is letters only (keeps it
  // simple; all current triggers are alpha). Whitespace after the
  // token is required.
  const m = text.match(/^\/([a-zA-Z]+)(\s+)([\s\S]*)$/)
  if (!m) return null
  const token = m[1].toLowerCase()
  const entry = aliasMap().get(token)
  if (!entry) return null
  return {
    skillId: entry.skillId,
    trigger: token,
    remainder: m[3].trimStart(),
  }
}

/**
 * Whether the input is in the "typing a slash command" state — leading
 * `/`, caret still inside the first token (no whitespace yet). Drives
 * the autocomplete's open/closed state. The body after a space is no
 * longer the command name, so the menu closes.
 */
export function isTypingSlashCommand(text: string): boolean {
  if (!text.startsWith("/")) return false
  return !/\s/.test(text)
}

/**
 * Autocomplete matches for the partial token the user has typed after
 * the `/`. `partial` is the text between the slash and the caret
 * (without the slash). Prefix-matches on any alias; an empty partial
 * returns every entry. De-duped by skill so a skill with both a long
 * trigger and an alias only appears once (matched on its canonical
 * trigger).
 */
export function matchSlashTriggers(partial: string): SlashTriggerEntry[] {
  const needle = partial.toLowerCase()
  if (!needle) return listSlashTriggers()
  return listSlashTriggers().filter((e) =>
    e.aliases.some((a) => a.toLowerCase().startsWith(needle))
  )
}
