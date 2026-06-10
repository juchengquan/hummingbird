import "server-only"

import type { RoutingConfig } from "@/shared/models"

/**
 * Smart model routing — the heuristic classifier behind the `auto`
 * model option (Tier-2, docs/PLAN-model-routing.md). Routes each turn to
 * the cheapest *capable* model: trivial turns → the weak model, hard
 * turns → the strong model.
 *
 * v1 is a pure rules-based classifier — zero added cost / latency, no new
 * dependency, and never an LLM call to decide (that would defeat the cost
 * saving). It misroutes sometimes; the per-message "routed to X" caption
 * (transparency) and the ability to pin a model are the safety valves,
 * and a tiny-LLM judge / cascade is the planned accuracy upgrade.
 *
 * A `Router` seam (this function behind a stable shape) lets a smarter
 * classifier — a small judge model, or RouteLLM's trained router on the
 * agent-py backend — drop in later without touching call sites.
 */

export interface RouteSignals {
  /** The latest user message text (already extracted server-side). */
  text: string
  /** Any attachments on the turn — documents usually mean a harder ask. */
  hasAttachments: boolean
  /** Conversation length — long threads carry more context to track. */
  messageCount: number
}

export interface RouteDecision {
  modelId: string
  tier: "strong" | "weak"
  /** Short machine reason for the choice — surfaced in debug logs. */
  reason: string
}

/** Prompts longer than this (chars) read as substantial asks. */
const HARD_LEN = 600
/** Conversations longer than this lean strong (more context to track). */
const HARD_MESSAGE_COUNT = 12
/** Markers of a non-trivial, reasoning-heavy ask. Word-boundaried,
 *  case-insensitive. Kept deliberately conservative — false "hard"
 *  routing just costs a bit more; the cascade upgrade tightens it. */
const COMPLEXITY_RE =
  /\b(design|architect(?:ure)?|debug|refactor|optimi[sz]e|prove|deriv(?:e|ation)|analy[sz]e|trade-?offs?|step[- ]by[- ]step|plan|implement|algorithm|complexity|reaso[n]|strateg(?:y|ise|ize))\b/i
/** A fenced code block (or a strong hint of code) signals a harder turn. */
const CODE_RE = /```|\bfunction\b|\bclass\b|=>|;\s*$/m

/**
 * Classify a turn and pick the model. Pure — same inputs, same output.
 */
export function routeModel(
  signals: RouteSignals,
  pair: RoutingConfig
): RouteDecision {
  const strong = (reason: string): RouteDecision => ({
    modelId: pair.strong,
    tier: "strong",
    reason,
  })
  const text = signals.text ?? ""

  if (signals.hasAttachments) return strong("attachments")
  if (signals.messageCount > HARD_MESSAGE_COUNT) return strong("long-thread")
  if (text.length > HARD_LEN) return strong("long-prompt")
  if (CODE_RE.test(text)) return strong("code")
  if (COMPLEXITY_RE.test(text)) return strong("complexity-keyword")

  return { modelId: pair.weak, tier: "weak", reason: "simple" }
}
