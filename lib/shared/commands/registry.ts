/**
 * Registry of `/` **action commands** — the run-now half of the slash
 * surface. Unlike skill triggers (`/search`, force a skill + send),
 * a command does something immediately and does NOT send a message:
 * `/new`, `/clear`, `/rename`, `/model`, `/help`.
 *
 * This module is pure metadata + parsing only — no actions, no store,
 * no React (the `run()` implementations live client-side in
 * `lib/client/hooks/use-slash-commands.ts`). Skills own the `/`
 * namespace alongside commands; a test asserts no trigger collides
 * across the two registries, so a token is unambiguously one or the
 * other. See `docs/PLAN-slash-action-commands.md`.
 */

import type { LucideIcon } from "lucide-react"
import { CircleHelp, Cpu, Eraser, Pencil, Plus } from "lucide-react"

export type CommandArgKind = "none" | "optional" | "required"

export type CommandId = "new" | "clear" | "rename" | "model" | "help"

export interface CommandDescriptor {
  id: CommandId
  /** Canonical trigger (shown in autocomplete). */
  trigger: string
  /** Extra accepted tokens. */
  aliases?: string[]
  /** Autocomplete primary label, e.g. "Rename conversation". */
  title: string
  /** Autocomplete secondary hint. */
  description: string
  argKind: CommandArgKind
  /** Placeholder shown after the trigger for arg commands, e.g. "<title>". */
  argHint?: string
  /** Route through the confirm dialog before running. */
  destructive?: boolean
  icon: LucideIcon
}

export const COMMANDS: CommandDescriptor[] = [
  {
    id: "new",
    trigger: "new",
    title: "New conversation",
    description: "Start a fresh chat in this workspace",
    argKind: "none",
    icon: Plus,
  },
  {
    id: "clear",
    trigger: "clear",
    title: "Clear conversation",
    description: "Remove every message in this chat",
    argKind: "none",
    destructive: true,
    icon: Eraser,
  },
  {
    id: "rename",
    trigger: "rename",
    title: "Rename conversation",
    description: "Set this chat's title",
    argKind: "required",
    argHint: "<title>",
    icon: Pencil,
  },
  {
    id: "model",
    trigger: "model",
    title: "Switch model",
    description: "Pick a model, or open the picker",
    argKind: "optional",
    argHint: "<name?>",
    icon: Cpu,
  },
  {
    id: "help",
    trigger: "help",
    aliases: ["help", "?"],
    title: "Slash & mention help",
    description: "List every / command and @ prompt trigger",
    argKind: "none",
    icon: CircleHelp,
  },
]

export interface CommandTriggerEntry {
  command: CommandDescriptor
  /** Canonical trigger. */
  trigger: string
  /** Canonical + aliases. */
  aliases: string[]
}

/** Flat trigger table; canonical-first. */
export function listCommandTriggers(): CommandTriggerEntry[] {
  return COMMANDS.map((command) => ({
    command,
    trigger: command.trigger,
    aliases: [command.trigger, ...(command.aliases ?? [])].filter(
      // de-dup in case `trigger` is repeated in `aliases` (help does).
      (v, i, arr) => arr.indexOf(v) === i
    ),
  }))
}

function commandAliasMap(): Map<string, CommandTriggerEntry> {
  const m = new Map<string, CommandTriggerEntry>()
  for (const e of listCommandTriggers()) {
    for (const a of e.aliases) m.set(a.toLowerCase(), e)
  }
  return m
}

export interface ParsedCommand {
  commandId: CommandId
  /** Matched token, lowercased. */
  trigger: string
  /** Remainder after `/trigger ` (trimmed). Empty for no-arg commands. */
  arg: string
}

/**
 * Resolve a leading `/command` from `text`. Unlike skill triggers,
 * a command does NOT require a trailing space — `/clear` on its own is
 * a valid invocation (instant commands have no body). An arg command
 * with a missing required arg (`/rename` alone, or `/rename ` with a
 * blank body) returns null — "still typing", not a fire.
 *
 * Token charset includes `?` so the `/?` help alias resolves.
 */
export function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith("/")) return null
  const m = text.match(/^\/([a-zA-Z?]+)(?:\s+([\s\S]*))?$/)
  if (!m) return null
  const token = m[1].toLowerCase()
  const entry = commandAliasMap().get(token)
  if (!entry) return null
  const arg = (m[2] ?? "").trim()
  if (entry.command.argKind === "required" && !arg) return null
  return { commandId: entry.command.id, trigger: token, arg }
}

/**
 * Autocomplete matches for a partial token typed after `/`. Empty
 * partial returns every command; otherwise prefix-matches on any alias.
 */
export function matchCommandTriggers(partial: string): CommandTriggerEntry[] {
  const needle = partial.toLowerCase()
  if (!needle) return listCommandTriggers()
  return listCommandTriggers().filter((e) =>
    e.aliases.some((a) => a.toLowerCase().startsWith(needle))
  )
}
