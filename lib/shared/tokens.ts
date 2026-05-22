import type { Message } from "@/shared/types"

/**
 * Estimate token count for a string. Uses a simple chars/4 heuristic
 * that's roughly accurate for English prose across model families.
 *
 * Why not a real tokenizer? Each model family uses a different one
 * (cl100k_base for GPT-4, tiktoken for o-series, SentencePiece for
 * Gemini, custom BPE for Claude, etc.). Bundling all of them is a
 * ~500KB cost; bundling the wrong one gives a confidently-wrong number.
 * The chars/4 heuristic is within ±20% across model families for
 * conversational text — accurate enough for a "you're getting close"
 * meter where exact precision doesn't matter.
 *
 * Code, JSON, and non-Latin scripts skew this heuristic in different
 * directions (code: lower ratio, CJK: higher). Treat the number as a
 * floor, not a ceiling.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/**
 * Estimate the total token count for a conversation. Sums every
 * message's content plus reasoning (if persisted) — reasoning still
 * counts against the context window when replayed.
 *
 * Compressed messages are skipped: they no longer travel to the model,
 * so they don't count against the window. The recap message that
 * replaced them counts normally.
 */
export function estimateConversationTokens(messages: Message[]): number {
  let total = 0
  for (const m of messages) {
    if (m.compressed) continue
    total += estimateTokens(m.content)
    if (m.reasoning) total += estimateTokens(m.reasoning)
  }
  return total
}

/** Color zone for a context-window indicator. Thresholds picked to
 *  match common UX patterns: green well below, amber when reaching the
 *  half/three-quarter mark, red when the model is about to drop oldest
 *  messages. */
export type ContextZone = "ok" | "warn" | "danger"

export function contextZone(used: number, total: number): ContextZone {
  if (total <= 0) return "ok"
  const ratio = used / total
  if (ratio >= 0.9) return "danger"
  if (ratio >= 0.5) return "warn"
  return "ok"
}

/** Format a token count compactly for UI display. e.g. 38_000 → "38k",
 *  1_200_000 → "1.2M", 540 → "540". */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(k >= 10 ? 0 : 1)}k`.replace(".0k", "k")
  }
  const m = n / 1_000_000
  return `${m.toFixed(m >= 10 ? 0 : 1)}M`.replace(".0M", "M")
}
