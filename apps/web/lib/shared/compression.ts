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

/**
 * Existing recap messages positioned before `beforeMessageId` in the
 * conversation. Used by the re-compress flow: when the user compresses
 * again, any recap that already sits ahead of the new slice gets folded
 * into the new recap (its content into the summariser input, its
 * `recapMessageIds` inherited) rather than left stacked. With the fold
 * in place there's normally at most one, but we return all for
 * robustness against legacy conversations that stacked recaps before
 * this landed.
 */
export function priorRecapsBefore(
  messages: Message[],
  beforeMessageId: string
): Message[] {
  const idx = messages.findIndex((m) => m.id === beforeMessageId)
  if (idx === -1) return []
  return messages.filter((m, i) => i < idx && m.kind === "recap")
}

export interface CompressionResult {
  /** The rebuilt message list: prior recaps dropped, the new recap
   *  inserted at the head of the compressed slice, the slice flagged
   *  `compressed`. */
  messages: Message[]
  /** The inserted recap (so the caller can scroll/focus it). */
  recap: Message
}

/**
 * Pure core of the `compressMessages` store mutator. Given the
 * conversation's messages, the ids being compressed, and a pre-summarised
 * recap body, produce the new message array + the recap row.
 *
 * Re-compress fold: any recap already sitting before the slice is
 * removed and its `recapMessageIds` are prepended to the new recap's, so
 * a single Undo restores every original message across both spans. The
 * caller is responsible for having folded those prior recaps' *content*
 * into `recapContent` (via `priorRecapsBefore` → summariser input).
 *
 * Returns null when none of `compressIds` are present (stale ids).
 */
export function buildCompressedMessages(
  messages: Message[],
  compressIds: string[],
  recapId: string,
  recapContent: string,
  now: Date
): CompressionResult | null {
  const idSet = new Set(compressIds)
  const firstIdx = messages.findIndex((m) => idSet.has(m.id))
  if (firstIdx === -1) return null

  const firstCompressId = messages[firstIdx].id
  const priorRecaps = priorRecapsBefore(messages, firstCompressId)
  const priorRecapIds = new Set(priorRecaps.map((r) => r.id))
  const inheritedIds = priorRecaps.flatMap((r) => r.recapMessageIds ?? [])

  const recap: Message = {
    id: recapId,
    role: "assistant",
    content: recapContent,
    timestamp: now,
    kind: "recap",
    recapMessageIds: [...inheritedIds, ...compressIds],
  }

  const next: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (priorRecapIds.has(m.id)) continue // fold: drop the old recap row
    if (i === firstIdx) next.push(recap)
    next.push(idSet.has(m.id) ? { ...m, compressed: true } : m)
  }
  return { messages: next, recap }
}

