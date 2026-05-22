import "server-only"

import type { Tool } from "ai"

import type { ChatRequestInput } from "@/shared/api-schemas"
import type { SkillId } from "@/shared/skills/types"

/**
 * Server-side skill registry.
 *
 * Each skill (today: `webSearch`, `webFetch`) exposes its server-side
 * surface — a system-prompt fragment + an AI-SDK tool builder — as a
 * `ServerSkill` object. The chat route iterates the registry instead of
 * branching per-skill, so adding a fourth skill takes one place to edit:
 * implement the interface in `lib/server/skills/<id>.ts` and push it to
 * `SERVER_SKILLS` below.
 *
 * The split between this server-side registry and the shared
 * `lib/shared/skills/registry.ts` is intentional. The shared registry
 * holds client-visible metadata (id, name, icon, default prefs) that
 * the workspace settings UI consumes. This server-side registry holds
 * the prompt + tool implementation, which references AI-SDK + server-
 * only deps that don't belong in the client bundle.
 */

/** Per-request runtime context passed to every skill implementation. */
export interface SkillRuntimeContext {
  /** Upstream request abort signal (typically `req.signal`).
   *  Implementations should propagate this into any outbound fetch so
   *  in-flight work cancels on client disconnect. */
  signal?: AbortSignal
  /** Per-IP cross-turn budget gate, shared across all chat-route web
   *  tools (webSearch + webFetch combined). Called once per tool
   *  invocation; on refusal the tool should return a soft error with
   *  the suggested retry-after. */
  consumeBudget?: () => { allowed: boolean; retryAfterSec: number }
}

/** A single entry on `ChatRequestInput["skills"]` — the per-skill
 *  config the client included with this request (cap + provider knobs
 *  for webSearch, cap for webFetch, etc.). Each skill picks out its
 *  own typed sub-object. */
export type SkillRequestEntry = NonNullable<ChatRequestInput["skills"]>[number]

export interface ServerSkill {
  id: SkillId
  /** Tool name surfaced to the model (matches the key under which
   *  `buildTool`'s return value gets registered). Stable identifier
   *  for tool_call records on message history. */
  toolName: string
  /** When the skill is enabled for this turn, build the AI-SDK tool.
   *  Returns null when this skill can't actually run (e.g. webSearch
   *  with all providers off — the prompt fragment then tells the
   *  model to fall back). */
  buildTool(
    requestEntry: SkillRequestEntry | undefined,
    ctx: SkillRuntimeContext
  ): Tool | null
  /** System-prompt fragment describing the skill to the model, or
   *  null when there's nothing to say. Receives the same request
   *  entry as `buildTool` so it can reflect per-provider toggles. */
  promptFragment(requestEntry: SkillRequestEntry | undefined): string | null
}

// Implementations are imported below from their per-skill modules so
// the wiring stays in one place. Each module owns its own log type,
// config resolution, and prompt copy.
import { imageGenSkill } from "@/server/skills/image-gen"
import { webFetchSkill } from "@/server/skills/web-fetch"
import { webSearchSkill } from "@/server/skills/web-search"

/** Iteration order matches the model-visible enablement order so the
 *  system prompt and tool registration are deterministic. Order is
 *  not load-bearing today, but tests pin it. */
export const SERVER_SKILLS: ServerSkill[] = [
  webSearchSkill,
  webFetchSkill,
  imageGenSkill,
]
