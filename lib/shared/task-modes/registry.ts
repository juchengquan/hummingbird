/**
 * Registry of task **modes** — Phase 1 (`PLAN-deep-research.md`).
 *
 * A task mode is a third slash kind alongside skills (`/search ...`,
 * forces a skill on the regular send) and action commands (`/new`,
 * `/clear`, etc., run-now no-send). It rewrites how a `POST /api/tasks`
 * is configured for one launch — system prompt, default `maxSteps`,
 * forced skills.
 *
 * Triggered as `/<trigger> <goal>` from the chat input, like a skill —
 * the body becomes the goal. Unlike skills, the mode is persisted in
 * `RunCheckpoint.config.mode` so the worker (and any subsequent chunks
 * after a yield) keeps the research-mode system prompt across the
 * whole run.
 *
 * Pure metadata + parsing only — no React, no I/O. The dispatcher in
 * `chat.tsx` reads the parse result, picks the forced skills, and
 * fires `taskRun.startTask({ ..., mode })`.
 */

import type { LucideIcon } from "lucide-react"
import { Microscope } from "lucide-react"

import type { SkillId } from "../skills/types"

/** v1 has one mode. Future modes (e.g. `audio-overview`) plug in
 *  here without further wiring beyond their own system prompt. */
export type TaskModeId = "research"

export interface TaskModeDescriptor {
  id: TaskModeId
  /** Canonical trigger token (no leading slash). */
  trigger: string
  /** Alternate accepted tokens. */
  aliases?: string[]
  /** Autocomplete primary label. */
  title: string
  /** Autocomplete secondary hint. */
  description: string
  /** Placeholder shown after the trigger, e.g. "<goal>". */
  argHint: string
  /** Skill ids force-enabled when this mode is selected (cascaded as
   *  if the user added them via `/<skill>` triggers). */
  forcedSkillIds: SkillId[]
  /** maxSteps for runs launched in this mode — bumped above the
   *  default 25 since research runs are by nature long. */
  defaultMaxSteps: number
  icon: LucideIcon
}

export const TASK_MODES: TaskModeDescriptor[] = [
  {
    id: "research",
    trigger: "research",
    title: "Deep research",
    description: "Multi-step research task → cited Markdown report",
    argHint: "<goal>",
    forcedSkillIds: ["webSearch", "webFetch"],
    defaultMaxSteps: 35,
    icon: Microscope,
  },
]

export interface TaskModeTriggerEntry {
  mode: TaskModeDescriptor
  trigger: string
  aliases: string[]
}

/** Flat trigger table; canonical-first. */
export function listTaskModeTriggers(): TaskModeTriggerEntry[] {
  return TASK_MODES.map((mode) => ({
    mode,
    trigger: mode.trigger,
    aliases: [mode.trigger, ...(mode.aliases ?? [])].filter(
      (v, i, arr) => arr.indexOf(v) === i
    ),
  }))
}

function modeAliasMap(): Map<string, TaskModeTriggerEntry> {
  const m = new Map<string, TaskModeTriggerEntry>()
  for (const e of listTaskModeTriggers()) {
    for (const a of e.aliases) m.set(a.toLowerCase(), e)
  }
  return m
}

export interface ParsedTaskMode {
  modeId: TaskModeId
  trigger: string
  /** Body after `/<trigger> ` — the goal. Trimmed. */
  goal: string
}

/**
 * Resolve a leading `/<task-mode> <goal>` directive. Mirrors the
 * skill-slash shape (`/search ...`) — requires whitespace after the
 * trigger AND a non-empty body (an empty goal is "still typing").
 */
export function parseTaskModeCommand(text: string): ParsedTaskMode | null {
  if (!text.startsWith("/")) return null
  const m = text.match(/^\/([a-zA-Z]+)(\s+)([\s\S]*)$/)
  if (!m) return null
  const token = m[1].toLowerCase()
  const entry = modeAliasMap().get(token)
  if (!entry) return null
  const goal = m[3].trim()
  if (!goal) return null
  return { modeId: entry.mode.id, trigger: token, goal }
}

/** Autocomplete matches for the partial token after `/`. */
export function matchTaskModeTriggers(partial: string): TaskModeTriggerEntry[] {
  const needle = partial.toLowerCase()
  if (!needle) return listTaskModeTriggers()
  return listTaskModeTriggers().filter((e) =>
    e.aliases.some((a) => a.toLowerCase().startsWith(needle))
  )
}
