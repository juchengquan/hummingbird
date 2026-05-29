import "server-only"

/**
 * Shared system-prompt builder for the agent task routes and the
 * worker. The text was previously duplicated in `app/api/tasks/route.ts`
 * and `app/api/tasks/[id]/respond/route.ts`; pulling it here keeps the
 * three callers (start route, respond route, worker `continue` action)
 * in lockstep so a model never gets a different system prompt depending
 * on which path runs.
 *
 * For `mode: 'research'` (Deep Research — `PLAN-deep-research.md`), the
 * default loop instructions are replaced wholesale with a research
 * workflow. Appending would invite the model to drift between two roles.
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
  /** Task mode — `'research'` swaps the loop instructions for the
   *  Deep Research workflow. Default / undefined keeps the standard
   *  multi-step agent prompt. */
  mode?: "default" | "research"
}

const DEFAULT_LOOP_PROMPT =
  "You are an autonomous agent inside the Hummingbird app, working on a " +
  "multi-step task. Start by calling `setPlan` with a short todo list " +
  "of the steps you intend to take, then update it (via `setPlan` " +
  "again) as steps move to 'in_progress' and 'completed'. Call the " +
  "available tools as needed and keep going until the task is " +
  "complete. If you need a decision from the user (which option to " +
  "pick, a value to use), call `askUser` — the run pauses and the " +
  "user's answer comes back as the tool's result. When you have " +
  "finished, write a clear final answer in Markdown."

const RESEARCH_LOOP_PROMPT =
  "You are a research agent inside the Hummingbird app. Your job is to " +
  "deliver a structured, cited Markdown report — not a chat reply — on " +
  "the user's research goal.\n\n" +
  "Workflow (follow it strictly):\n\n" +
  "1. Plan. Call `setPlan` once with 5–10 concrete sub-questions that, " +
  "when answered, will fully address the goal. Each sub-question " +
  "becomes one section of the final report. Use stable ids you can " +
  "reuse across updates.\n" +
  "2. Research each sub-question in plan order:\n" +
  "   a. Update `setPlan` to mark the current item `in_progress`.\n" +
  "   b. Use `webSearch` to find candidate sources (start broad, then " +
  "narrow).\n" +
  "   c. Use `webFetch` to read the 2–4 most promising results.\n" +
  "   d. Write a short factual note (2–6 sentences) for that " +
  "sub-question, citing source URLs with `[N]` markers in the order " +
  "they were discovered.\n" +
  "   e. Update `setPlan` to mark the item `completed` and the next " +
  "one `in_progress`.\n" +
  "3. Gap pass. Re-read your notes. Identify sub-questions that are " +
  "under-supported (only one source, contradictions, key claim " +
  "unanchored). For each, run one targeted `webSearch` + `webFetch` " +
  "to fill the gap. Update notes in place.\n" +
  "4. Synthesize. Write the final report as Markdown with:\n" +
  "   - A short executive summary (3–5 sentences).\n" +
  "   - One `##` section per sub-question, in plan order, headed by " +
  "the sub-question.\n" +
  "   - Inline `[N]` markers tying every non-trivial claim to a source.\n" +
  "   - A `## Sources` section at the end listing each source as " +
  "`[N] Title — URL`.\n\n" +
  "Constraints:\n" +
  "- Do not pad. If a sub-question was empty, say so and move on.\n" +
  "- Prefer recent (≤ 24 months) sources except for definitional context.\n" +
  "- Do not editorialize beyond what your sources support.\n" +
  "- Do not ask the user clarifying questions in research mode — raise " +
  "an `askUser` only when a sub-question genuinely needs a real-world " +
  "choice from the user (a target audience, a specific product to " +
  "compare against, etc.).\n" +
  "- Stop when the Markdown report is written. The settled report is " +
  "the deliverable; no chat reply is needed."

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
  const loopPrompt =
    opts.mode === "research" ? RESEARCH_LOOP_PROMPT : DEFAULT_LOOP_PROMPT
  return [trimmedWorkspace, loopPrompt, skillsLine, mcpLine]
    .filter(Boolean)
    .join("\n\n")
}
