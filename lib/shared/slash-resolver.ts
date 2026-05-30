/**
 * Unified `/` resolver: the `/` namespace hosts four kinds — **task
 * modes** (force a task mode + send, see `task-modes/registry.ts`),
 * **personas / custom agents** (apply a saved recipe + send, see
 * `agents/slash-parser.ts`), **skills** (force a skill + send), and
 * **action commands** (run now, no send). `@` is a separate surface
 * (prompt mentions) and is not handled here.
 *
 * Persona slugs are user-supplied — the workspace's active personas
 * are passed in as the optional `agents` arg. The other three trigger
 * namespaces are compile-time and never collide (asserted in tests).
 * Resolution order: agent → task_mode → skill → command. Agents go
 * first because their slugs are the broadest charset; the more
 * specific compile-time triggers fall through cleanly when no persona
 * matches. See `docs/PLAN-slash-action-commands.md`,
 * `docs/PLAN-deep-research.md`, and `docs/PLAN-custom-agents.md`.
 */

import type { LucideIcon } from "lucide-react"
import { UserCircle } from "lucide-react"

import {
  matchAgentSlugs,
  parseAgentSlash,
} from "./agents/slash-parser"
import {
  matchCommandTriggers,
  parseCommand,
  type CommandArgKind,
  type CommandId,
} from "./commands/registry"
import {
  matchSlashTriggers,
  parseSlashCommand,
} from "./skills/slash-parser"
import type { SkillId } from "./skills/types"
import {
  matchTaskModeTriggers,
  parseTaskModeCommand,
  type TaskModeId,
} from "./task-modes/registry"
import type { Agent } from "./types"

export type SlashResolution =
  | { kind: "skill"; skillId: SkillId; trigger: string; remainder: string }
  | { kind: "command"; commandId: CommandId; trigger: string; arg: string }
  | {
      kind: "task_mode"
      modeId: TaskModeId
      trigger: string
      /** The body the user typed — sent as the message. */
      goal: string
    }
  | {
      kind: "agent"
      agentId: string
      slug: string
      /** Body after the slug, sent as the user message. */
      remainder: string
    }
  | null

export interface ResolveSlashOptions {
  /** Active workspace's personas (non-deleted only is fine; the parser
   *  also filters). When omitted or empty, persona resolution is
   *  skipped entirely. */
  agents?: Agent[]
}

/**
 * Resolve a leading `/` directive for the send path. Tries personas
 * first (the broadest charset), then task modes, then skills (require
 * a trailing space + body), then commands (can stand alone). Returns
 * null for plain text or an unknown token.
 */
export function resolveSlash(
  text: string,
  opts?: ResolveSlashOptions
): SlashResolution {
  const agentMatch = opts?.agents
    ? parseAgentSlash(text, opts.agents)
    : null
  if (agentMatch) {
    return {
      kind: "agent",
      agentId: agentMatch.agent.id,
      slug: agentMatch.trigger,
      remainder: agentMatch.remainder,
    }
  }
  const taskMode = parseTaskModeCommand(text)
  if (taskMode) {
    return {
      kind: "task_mode",
      modeId: taskMode.modeId,
      trigger: taskMode.trigger,
      goal: taskMode.goal,
    }
  }
  const skill = parseSlashCommand(text)
  if (skill) {
    return {
      kind: "skill",
      skillId: skill.skillId,
      trigger: skill.trigger,
      remainder: skill.remainder,
    }
  }
  const command = parseCommand(text)
  if (command) {
    return {
      kind: "command",
      commandId: command.commandId,
      trigger: command.trigger,
      arg: command.arg,
    }
  }
  return null
}

/** One row in the grouped `/` autocomplete. */
export interface SlashMenuEntry {
  kind: "skill" | "command" | "task_mode" | "agent"
  /** Stable id (skillId / commandId / taskModeId / agentId). */
  id: string
  /** Canonical trigger, e.g. "rename". */
  trigger: string
  /** Secondary hint shown next to the trigger. */
  hint: string
  /** Section header. */
  group: "Commands" | "Skills" | "Modes" | "Personas"
  icon: LucideIcon
  /** Only set for commands: lets the picker decide run-now vs
   *  complete-to-`/trigger ` for an arg. */
  argKind?: CommandArgKind
}

/**
 * Build the grouped autocomplete list for the partial token after `/`.
 * Personas first (user-curated; surface first), then modes (rarer +
 * heavier), then commands, then skills. Empty partial lists everything.
 */
export function matchSlashMenu(
  partial: string,
  opts?: ResolveSlashOptions
): SlashMenuEntry[] {
  const agents: SlashMenuEntry[] = opts?.agents
    ? matchAgentSlugs(partial, opts.agents).map((a) => ({
        kind: "agent" as const,
        id: a.id,
        trigger: a.slug,
        hint: a.name,
        group: "Personas" as const,
        icon: UserCircle,
      }))
    : []
  const modes: SlashMenuEntry[] = matchTaskModeTriggers(partial).map((e) => ({
    kind: "task_mode",
    id: e.mode.id,
    trigger: e.trigger,
    hint: `${e.mode.title} ${e.mode.argHint}`,
    group: "Modes",
    icon: e.mode.icon,
  }))
  const commands: SlashMenuEntry[] = matchCommandTriggers(partial).map((e) => ({
    kind: "command",
    id: e.command.id,
    trigger: e.trigger,
    hint: e.command.argHint
      ? `${e.command.title} ${e.command.argHint}`
      : e.command.title,
    group: "Commands",
    icon: e.command.icon,
    argKind: e.command.argKind,
  }))
  const skills: SlashMenuEntry[] = matchSlashTriggers(partial).map((e) => ({
    kind: "skill",
    id: e.skillId,
    trigger: e.trigger,
    hint: e.skill.name,
    group: "Skills",
    icon: e.skill.icon,
  }))
  return [...agents, ...modes, ...commands, ...skills]
}
