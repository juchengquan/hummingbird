/**
 * Shared follow-up suggestion JSON parser. Pure — no React, no fetch,
 * no provider SDK — so both the Next.js inline route
 * (`lib/server/chat/suggestions.ts`) and the agent-ts service
 * (`services/agent-ts/src/chat.ts`) consume it directly. The Python
 * service keeps a hand-coded mirror in `agent_py.chat.parse_suggestions_json`
 * because cross-language sharing isn't viable for runtime code.
 *
 * Contract — same across all three backends:
 *   - input is the model's raw text response, possibly fenced
 *     (`` ```json ``) and possibly with surrounding whitespace
 *   - output is at most 3 non-empty strings, each ≤ 120 chars
 *   - any decode / shape failure yields an empty array (chips are
 *     decoration; failures must never block a chat turn)
 */

const FENCE_HEAD_RE = /^```(?:json)?\s*\n?/
const FENCE_TAIL_RE = /\n?```\s*$/

/** Max characters per suggestion. Long suggestions usually mean the
 *  model emitted prose rather than a chip — drop them rather than
 *  cluttering the UI. */
export const SUGGESTION_MAX_CHARS = 120

/** Max number of suggestions emitted. Bounded to keep the chip strip
 *  compact and predictable. */
export const SUGGESTION_MAX_COUNT = 3

/** Strip optional markdown fences from a model-emitted JSON payload,
 *  then parse + validate as a flat string array. Returns at most
 *  `SUGGESTION_MAX_COUNT` short non-empty entries. Permissive — any
 *  decode failure yields an empty array. */
export function parseSuggestionsJson(raw: string): string[] {
  const cleaned = raw
    .trim()
    .replace(FENCE_HEAD_RE, "")
    .replace(FENCE_TAIL_RE, "")
    .trim()
  try {
    const parsed = JSON.parse(cleaned) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= SUGGESTION_MAX_CHARS)
      .slice(0, SUGGESTION_MAX_COUNT)
  } catch {
    return []
  }
}
