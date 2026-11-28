/**
 * Shared types + cascade for chat skills.
 *
 * A skill is a model capability the user can opt into per chat (web
 * search, image generation, code exec, page fetch, memory recall, …).
 * Each has a stable string id used as the key in the `skill_prefs`
 * JSONB columns on `workspaces` and `conversations`.
 *
 * `resolveSkill` is the single source of truth for "is skill S effectively
 * on for this conversation?" — used both by the Skills panel UI and by
 * the chat panel when assembling the API request.
 */

import type { LucideIcon } from "lucide-react"

export type SkillId =
  | "webSearch"
  | "webFetch"
  | "imageGen"
  | "searchFiles"
  | "codeInterpreter"

/**
 * Tool name exposed to the model for the web-search skill. The skill
 * dispatches to one or more providers under the hood (Tavily + Brave
 * today), but the model only sees a single `webSearch` tool.
 * `isWebSearchToolName` is the canonical check so future provider
 * additions can extend the union here without each UI consumer
 * hardcoding the string.
 */
export const WEB_SEARCH_TOOL_NAMES = ["webSearch"] as const
export type WebSearchToolName = (typeof WEB_SEARCH_TOOL_NAMES)[number]

export function isWebSearchToolName(name: string): name is WebSearchToolName {
  return (WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * Tool name exposed to the model for the searchFiles skill (Phase 3
 * of the file full-text retrieval plan). Mirrors the webSearch pattern
 * so UI consumers don't hardcode the string and future tool-name
 * variants (e.g. cross-file search) can extend the union here.
 */
export const SEARCH_FILES_TOOL_NAMES = ["searchFiles"] as const
export type SearchFilesToolName = (typeof SEARCH_FILES_TOOL_NAMES)[number]

export function isSearchFilesToolName(name: string): name is SearchFilesToolName {
  return (SEARCH_FILES_TOOL_NAMES as readonly string[]).includes(name)
}

export interface SkillDescriptor {
  id: SkillId
  name: string
  description: string
  icon: LucideIcon
  default: boolean
  /**
   * True when the skill needs server-side env / secrets to actually work.
   * The Skills panel still shows it (so users learn it exists), but it's
   * rendered with an "not configured" hint and the chat route will omit
   * the tool from the model's tool list.
   *
   * Resolved at server boundary — for now, a hardcoded set on the client
   * mirrors the route's check. (We do not expose env to the browser.)
   */
  requiresEnv?: boolean
  /**
   * Slash-command shortcuts that force this skill on for the turn,
   * overriding the workspace/conversation cascade. Typed as `/search …`
   * in the chat input. First trigger is canonical (shown in the
   * autocomplete); later entries are accepted as aliases on input.
   * Triggers must be unique across the whole registry. Skills own the
   * `/` namespace; user prompt templates use `@` (see
   * `docs/PLAN-slash-commands.md` — two-symbol model), so there's no
   * collision to resolve here.
   */
  slashTriggers?: string[]
}

export type SkillPrefs = Partial<Record<SkillId, boolean>>

export function resolveSkill(
  skill: SkillDescriptor,
  workspacePrefs: SkillPrefs | undefined,
  conversationPrefs: SkillPrefs | undefined
): boolean {
  if (conversationPrefs && skill.id in conversationPrefs) {
    return Boolean(conversationPrefs[skill.id])
  }
  if (workspacePrefs && skill.id in workspacePrefs) {
    return Boolean(workspacePrefs[skill.id])
  }
  return skill.default
}
