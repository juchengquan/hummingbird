/**
 * Unified `/` resolver: the `/` namespace hosts three kinds — **task
 * modes** (force a task mode + send, see `task-modes/registry.ts`),
 * **skills** (force a skill + send), and **action commands** (run now,
 * no send). `@` is a separate surface (prompt mentions) and is not
 * handled here.
 *
 * `resolveSlash` is the send-path entry point; `matchSlashMenu` builds
 * the grouped autocomplete list. The three trigger namespaces share
 * `/` but never collide (asserted in tests), so resolution order is
 * irrelevant for correctness — we still try task modes first to give
 * a clear longest-match precedence. See
 * `docs/PLAN-slash-action-commands.md` and `docs/PLAN-deep-research.md`.
 */

import type { LucideIcon } from "lucide-react"

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
  | null

/**
 * Resolve a leading `/` directive for the send path. Tries task modes
 * first (longest-match precedence), then skills (require a trailing
 * space + body), then commands (can stand alone). Returns null for
 * plain text or an unknown token.
 */
export function resolveSlash(text: string): SlashResolution {
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
  kind: "skill" | "command" | "task_mode"
  /** Stable id (skillId / commandId / taskModeId). */
  id: string
  /** Canonical trigger, e.g. "rename". */
  trigger: string
  /** Secondary hint shown next to the trigger. */
  hint: string
  /** Section header. */
  group: "Commands" | "Skills" | "Modes"
  icon: LucideIcon
  /** Only set for commands: lets the picker decide run-now vs
   *  complete-to-`/trigger ` for an arg. */
  argKind?: CommandArgKind
}

/**
 * Build the grouped autocomplete list for the partial token after `/`.
 * Modes first (rarer + heavier — surface them), then commands (the
 * run-now actions a user most expects from `/`), then skills. Empty
 * partial lists everything.
 */
export function matchSlashMenu(partial: string): SlashMenuEntry[] {
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
  return [...modes, ...commands, ...skills]
}
