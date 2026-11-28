import { SKILLS } from "./registry"
import { resolveSkill } from "./types"
import {
  resolveWebSearchConfig,
  type WebSearchConfig,
} from "./web-search-config"
import {
  resolveWebFetchConfig,
  type WebFetchConfig,
} from "./web-fetch-config"
import {
  resolveImageGenConfig,
  type ImageGenConfig,
} from "./image-gen-config"

/**
 * One entry in the `skills` array of a chat/task request — the skill id
 * plus, for the few skills that take structured config, a clamped copy
 * of the resolved cascade. Mirrors `ChatRequestSchema.shape.skills`
 * (and `TaskRequestSchema`, which reuses it).
 */
export interface SkillRequestEntry {
  id: string
  webSearchConfig?: {
    maxCalls: number
    tavily: { enabled: boolean; searchDepth: "basic" | "advanced" }
    brave: { enabled: boolean; freshness: "any" | "pd" | "pw" | "pm" | "py" }
    exa: { enabled: boolean; type: "auto" | "neural" | "keyword" }
  }
  webFetchConfig?: { maxCalls: number }
  imageGenConfig?: {
    maxCalls: number
    aspectRatio: "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "2:3" | "3:2"
  }
}

/**
 * Anything that carries skill preferences + per-skill config in the
 * cascade — i.e. a `Workspace` or a `Conversation`. Kept structural so
 * callers don't have to import the full entity types.
 */
export interface SkillCascadeSource {
  skillPrefs?: Record<string, boolean>
  webSearchConfig?: WebSearchConfig
  webFetchConfig?: WebFetchConfig
  imageGenConfig?: ImageGenConfig
}

export interface ResolveEnabledSkillsOptions {
  /** Workspace-level defaults (the base of the cascade). */
  workspace?: SkillCascadeSource | null
  /** Conversation-level overrides layered on top of the workspace. Omit
   *  for a context with no conversation (e.g. a project-board card run). */
  conversation?: SkillCascadeSource | null
  /** Skills force-enabled for this one request (e.g. a slash command),
   *  even if the cascade has them off. */
  forcedSkillIds?: Iterable<string>
  /** Skills muted for this one request — mute wins over both the cascade
   *  and `forcedSkillIds` (explicit "off" beats explicit "on"). */
  mutedSkillIds?: Iterable<string>
}

/**
 * Resolve which skills are effectively on for a chat/task request and
 * build their request entries (with clamped per-skill config) in one
 * pass. The effective set is:
 *
 *   (workspace/conversation cascade ∪ forced) − muted
 *
 * The shared core behind both the chat send path and the project-board
 * "Run as task" action — a card has no conversation/forced/muted layer,
 * so it just passes `{ workspace }`.
 */
export function resolveEnabledSkills(
  opts: ResolveEnabledSkillsOptions
): SkillRequestEntry[] {
  const forced = new Set(opts.forcedSkillIds ?? [])
  const muted = new Set(opts.mutedSkillIds ?? [])
  const ws = opts.workspace ?? undefined
  const conv = opts.conversation ?? undefined

  return SKILLS.filter(
    (s) =>
      (resolveSkill(s, ws?.skillPrefs, conv?.skillPrefs) || forced.has(s.id)) &&
      !muted.has(s.id)
  ).map((s) => {
    const entry: SkillRequestEntry = { id: s.id }
    if (s.id === "webSearch") {
      const r = resolveWebSearchConfig(ws?.webSearchConfig, conv?.webSearchConfig)
      entry.webSearchConfig = {
        maxCalls: r.maxCalls,
        tavily: { enabled: r.tavily.enabled, searchDepth: r.tavily.searchDepth },
        brave: { enabled: r.brave.enabled, freshness: r.brave.freshness },
        exa: { enabled: r.exa.enabled, type: r.exa.type },
      }
    }
    if (s.id === "webFetch") {
      const r = resolveWebFetchConfig(ws?.webFetchConfig, conv?.webFetchConfig)
      entry.webFetchConfig = { maxCalls: r.maxCalls }
    }
    if (s.id === "imageGen") {
      const r = resolveImageGenConfig(ws?.imageGenConfig, conv?.imageGenConfig)
      entry.imageGenConfig = { maxCalls: r.maxCalls, aspectRatio: r.aspectRatio }
    }
    return entry
  })
}
