import "server-only"

/**
 * Shared system-prompt builder for the agent task routes and the
 * worker. The text was previously duplicated in `app/api/tasks/route.ts`
 * and `app/api/tasks/[id]/respond/route.ts`; pulling it here keeps the
 * three callers (start route, respond route, worker `continue` action)
 * in lockstep so a model never gets a different system prompt depending
 * on which path runs.
 */

import {
  SERVER_SKILLS,
  type SkillRequestEntry,
} from "@/server/skills/registry"
import type { SkillId } from "@/shared/skills/types"

export interface BuildTaskSystemPromptOptions {
  workspaceSystemPrompt?: string
  enabledSkillIds: SkillId[]
  skillRequestEntries: SkillRequestEntry[]
  mcpServers?: { name: string; toolCount: number }[]
}

export function buildTaskSystemPrompt(
  opts: BuildTaskSystemPromptOptions
): string {
  const trimmedWorkspace = opts.workspaceSystemPrompt?.trim()
  const enabled = new Set<SkillId>(opts.enabledSkillIds)
  const entryById = new Map<string, SkillRequestEntry>(
    opts.skillRequestEntries.map((s) => [s.id, s])
  )
  const notes: string[] = []
  for (const skill of SERVER_SKILLS) {
    if (!enabled.has(skill.id)) continue
    const fragment = skill.promptFragment(entryById.get(skill.id))
    if (fragment) notes.push(fragment)
  }
  const skillsLine =
    notes.length > 0
      ? `Available capabilities:\n${notes.map((n) => `- ${n}`).join("\n")}`
      : null
  const activeMcp = (opts.mcpServers ?? []).filter((s) => s.toolCount > 0)
  const mcpLine =
    activeMcp.length > 0
      ? `You also have tools from connected MCP servers (prefixed ` +
        `\`mcp__<serverId>__<toolName>\`); call them when relevant. ` +
        `Connected:\n${activeMcp
          .map((s) => `- "${s.name}" (${s.toolCount} tools)`)
          .join("\n")}`
      : null
  return [
    trimmedWorkspace,
    "You are an autonomous agent inside the Hummingbird app, working on a " +
      "multi-step task. Start by calling `setPlan` with a short todo list " +
      "of the steps you intend to take, then update it (via `setPlan` " +
      "again) as steps move to 'in_progress' and 'completed'. Call the " +
      "available tools as needed and keep going until the task is " +
      "complete. If you need a decision from the user (which option to " +
      "pick, a value to use), call `askUser` — the run pauses and the " +
      "user's answer comes back as the tool's result. When you have " +
      "finished, write a clear final answer in Markdown.",
    skillsLine,
    mcpLine,
  ]
    .filter(Boolean)
    .join("\n\n")
}
