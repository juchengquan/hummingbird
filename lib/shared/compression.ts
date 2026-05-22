import type { Message } from "@/shared/types"

/**
 * Pure logic deciding which messages the "Compress older messages"
 * action should send to the summarizer. Lives in `lib/shared` so the
 * dialog (which previews the count + retained tail) and the panel
 * (which executes) both see exactly the same answer.
 *
 * The rule:
 *   1. Eligible = messages with content, not already compressed, not
 *      an existing recap, not in an error state, and not still
 *      streaming. Compressed messages and recap messages would either
 *      double-summarise or confuse the model.
 *   2. Compress the oldest ~60% of the eligible set; retain the
 *      newest 40%.
 *   3. If after the rule the to-compress set has fewer than 2 messages,
 *      return null — there's nothing useful to compress, and the
 *      dialog hides the action.
 *
 * Returning a single struct (rather than just an array) means the UI
 * has the retained count handy for the confirmation copy without
 * re-doing the math.
 */
export interface CompressionPick {
  toCompress: Message[]
  retainedCount: number
}

/** Inclusive lower bound on how many messages must end up in
 *  `toCompress` for the action to be offered at all. Two is the
 *  smallest count where a "recap" is meaningfully shorter than the
 *  originals it replaces. */
export const MIN_MESSAGES_TO_COMPRESS = 2

/** Fraction of eligible messages routed into `toCompress`. The rest
 *  stay verbatim in the chat history. 0.6 was picked so a 10-message
 *  conversation compresses 6 / keeps 4, which matches what most users
 *  do manually. */
const OLDEST_FRACTION = 0.6

export function pickCompressionRange(
  messages: Message[]
): CompressionPick | null {
  const eligible = messages.filter(isEligible)
  if (eligible.length < MIN_MESSAGES_TO_COMPRESS * 2) {
    // Not enough headroom — even at 100% we'd be summarising too few
    // messages to be worth the round trip.
    return null
  }
  const cut = Math.max(
    MIN_MESSAGES_TO_COMPRESS,
    Math.floor(eligible.length * OLDEST_FRACTION)
  )
  const toCompress = eligible.slice(0, cut)
  if (toCompress.length < MIN_MESSAGES_TO_COMPRESS) return null
  return {
    toCompress,
    retainedCount: eligible.length - toCompress.length,
  }
}

function isEligible(m: Message): boolean {
  if (!m.content) return false
  if (m.compressed) return false
  if (m.kind === "recap") return false
  if (m.error) return false
  return true
}
