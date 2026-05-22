/**
 * Slash commands — terse keyboard shortcuts for forcing a specific
 * skill on for the next turn. Typing `/search latest AI news` and
 * hitting Enter strips the `/search ` prefix from the message,
 * enables the `webSearch` skill for that one send (even if the
 * conversation has it off), and tells the model to use it.
 *
 * Lives in `lib/shared` so the popover (autocomplete) and the
 * chat panel (parser at send time) both read from the same list.
 *
 * The mapping is intentionally one-command-to-one-skill — no
 * multi-skill chains in v1. A user who wants both /search and /fetch
 * can leave the skills on in the cascade and just type their message.
 */

import type { SkillId } from "./skills/types"

export interface SlashCommand {
  /** The literal token typed after the slash. Lowercase, no spaces. */
  prefix: string
  /** Skill id forced ON for the next turn when this command is invoked. */
  skillId: SkillId
  /** Short hint shown in the autocomplete popover. */
  description: string
}

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    prefix: "search",
    skillId: "webSearch",
    description: "Search the web for the rest of this message",
  },
  {
    prefix: "image",
    skillId: "imageGen",
    description: "Generate an image from the rest of this message",
  },
  {
    prefix: "fetch",
    skillId: "webFetch",
    description: "Fetch a URL and read its contents",
  },
]

/**
 * Parse a chat-input string for a leading slash command. Returns the
 * matched command + the remainder (with the prefix stripped) on a hit;
 * returns null otherwise. The match is case-insensitive on the prefix
 * but preserves the body verbatim.
 *
 * A trailing space is required after the prefix — `/search` on its own
 * is treated as the user still typing, not as an invocation with an
 * empty body. That matches how Slack / Discord / VS Code handle the
 * same shape and keeps a half-typed `/searchwhatever` from being
 * misinterpreted.
 */
export function parseSlashCommand(
  input: string
): { command: SlashCommand; body: string } | null {
  if (!input.startsWith("/")) return null
  // Find the first whitespace boundary. Everything between the slash
  // and that boundary is the candidate prefix.
  const match = input.match(/^\/([a-zA-Z][a-zA-Z0-9]*)\s+([\s\S]*)$/)
  if (!match) return null
  const prefix = match[1].toLowerCase()
  const body = match[2].trim()
  if (!body) return null
  const command = SLASH_COMMANDS.find((c) => c.prefix === prefix)
  if (!command) return null
  return { command, body }
}

/**
 * Filter the command list for autocomplete. Matches case-insensitively
 * on a prefix-of-the-prefix (so `/s` returns the search command,
 * `/se` still returns it). Returns the full list when called with an
 * empty needle.
 */
export function matchSlashCommands(needle: string): SlashCommand[] {
  const n = needle.toLowerCase()
  if (!n) return [...SLASH_COMMANDS]
  return SLASH_COMMANDS.filter((c) => c.prefix.startsWith(n))
}

/**
 * Check whether an input string is in the "still typing the command"
 * state — leading slash, no whitespace yet. Drives the popover's
 * open/closed state.
 */
export function isTypingSlashCommand(input: string): boolean {
  if (!input.startsWith("/")) return false
  // Open while there's no whitespace yet. Once the user types a space,
  // they're past the command name and onto the body — popover closes.
  return !/\s/.test(input)
}
