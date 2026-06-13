import { Tiktoken } from "js-tiktoken/lite"
import cl100k_base from "js-tiktoken/ranks/cl100k_base"
import o200k_base from "js-tiktoken/ranks/o200k_base"

import { getChatModel } from "@/shared/models"
import type { Message } from "@/shared/types"

/**
 * Token estimation for the context meter + the Compress action's
 * surface-decision.
 *
 * Two paths, picked per model via its `tokenizer` config field:
 *
 * - **Real tokenizer** (`js-tiktoken`) for models whose family publishes
 *   a public encoder. `tiktoken-o200k` for modern OpenAI; `tiktoken-cl100k`
 *   for older OpenAI and as a within-a-few-% proxy for Anthropic (Claude's
 *   tokenizer is close to `cl100k_base`).
 * - **chars/4 heuristic** for everything else (Gemini / DeepSeek / MiniMax
 *   / Ollama — none publish a public tokenizer). Within ±20% on English
 *   prose, but undercounts code/JSON by 30-50%, which is why the meter
 *   uses the real encoder where one exists.
 *
 * Residual error on the heuristic path is ±~10-20%; treat its number as a
 * floor. The encoder path is exact for OpenAI and within a few % for
 * Anthropic.
 *
 * Isomorphic — `js-tiktoken` is pure JS (no native addon, no I/O), so this
 * runs unchanged in the browser meter and on the server.
 */

export type TokenizerId = "tiktoken-cl100k" | "tiktoken-o200k" | "heuristic"

type EncodingName = "cl100k_base" | "o200k_base"

// Importing the two rank files explicitly (rather than the convenience
// `getEncoding`, which can pull every encoding's ranks) keeps the client
// bundle to just cl100k + o200k. Constructing a Tiktoken costs ~50 ms, so
// build each at most once and reuse — microseconds per encode thereafter.
const encoderCache = new Map<EncodingName, Tiktoken>()

function encoderFor(name: EncodingName): Tiktoken {
  let enc = encoderCache.get(name)
  if (!enc) {
    enc = new Tiktoken(name === "o200k_base" ? o200k_base : cl100k_base)
    encoderCache.set(name, enc)
  }
  return enc
}

/** The tokenizer configured for a model id (via its `config/models.json`
 *  entry). Unknown / untagged model → `heuristic`. */
export function tokenizerForModelId(modelId?: string): TokenizerId {
  if (!modelId) return "heuristic"
  return getChatModel(modelId)?.tokenizer ?? "heuristic"
}

/**
 * Estimate token count for a string under an explicit tokenizer. The pure
 * core both public estimators share — no model-config lookup, so it's the
 * seam unit tests exercise directly. Never throws: an encoder failure
 * falls back to the heuristic (this is a meter, not a gate).
 */
export function estimateTokensWith(text: string, tokenizer: TokenizerId): number {
  if (!text) return 0
  if (tokenizer === "heuristic") return Math.ceil(text.length / 4)
  const name: EncodingName =
    tokenizer === "tiktoken-o200k" ? "o200k_base" : "cl100k_base"
  try {
    return encoderFor(name).encode(text).length
  } catch {
    return Math.ceil(text.length / 4)
  }
}

/**
 * Estimate token count for a string. Pass the active `modelId` to pick the
 * model's tokenizer; omit it (or pass an untagged model) for the chars/4
 * heuristic.
 */
export function estimateTokens(text: string, modelId?: string): number {
  return estimateTokensWith(text, tokenizerForModelId(modelId))
}

/**
 * Estimate the total token count for a conversation. Sums every message's
 * content plus reasoning (if persisted) — reasoning still counts against
 * the context window when replayed.
 *
 * Compressed messages are skipped: they no longer travel to the model, so
 * they don't count against the window. The recap message that replaced
 * them counts normally.
 *
 * Resolves the tokenizer once for the whole conversation (not per message).
 */
export function estimateConversationTokens(
  messages: Message[],
  modelId?: string
): number {
  const tokenizer = tokenizerForModelId(modelId)
  let total = 0
  for (const m of messages) {
    if (m.compressed) continue
    total += estimateTokensWith(m.content, tokenizer)
    if (m.reasoning) total += estimateTokensWith(m.reasoning, tokenizer)
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
