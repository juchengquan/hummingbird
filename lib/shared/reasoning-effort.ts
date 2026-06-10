/**
 * Reasoning-effort control — maps a user-chosen effort tier onto the
 * provider-specific "thinking budget" / "reasoning effort" knobs the AI
 * SDK forwards (through the Vercel AI Gateway) to the upstream model.
 *
 * Pure + isomorphic (no I/O): imported by the chat route to build
 * `streamText`'s `providerOptions`, and re-exported alongside the model
 * registry for the client picker. The capability gate
 * (`modelSupportsReasoningEffort`) lives in `@/shared/models` because it
 * reads `config/models.json`.
 */

export type ReasoningEffort = "low" | "medium" | "high"

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
]

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return v === "low" || v === "medium" || v === "high"
}

/**
 * Thinking-token budgets per tier for budget-style providers (Anthropic,
 * Google). Anthropic additionally requires `maxOutputTokens >
 * budgetTokens`, so the mapper returns a matching `maxOutputTokens` for
 * Anthropic models (budget + room for the answer itself).
 */
const THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
}

/** Headroom for the answer on top of the Anthropic thinking budget. */
const ANSWER_MARGIN = 8192

export interface ReasoningCallOptions {
  /** Provider-namespaced options to merge into `streamText`'s
   *  `providerOptions`. Empty when the model's provider has no mapping —
   *  callers can spread it unconditionally. */
  providerOptions: Record<string, Record<string, unknown>>
  /** Set for Anthropic models only (`max_tokens` must exceed the thinking
   *  budget). Undefined otherwise. */
  maxOutputTokens?: number
}

const EMPTY: ReasoningCallOptions = { providerOptions: {} }

/**
 * Map a model id + chosen effort onto call options. Dispatches on the
 * provider prefix of the model id (`anthropic/…`, `openai/…`,
 * `google/…`). Returns an empty result for a null/undefined effort or a
 * provider with no mapping (e.g. `ollama/…`, `openrouter/…`), so the
 * result is always safe to spread.
 *
 * Provider-namespaced options are a no-op on providers that don't
 * recognise them, so even if a gateway forwards an unexpected namespace
 * it's ignored upstream.
 */
export function reasoningCallOptions(
  modelId: string,
  effort: ReasoningEffort | null | undefined
): ReasoningCallOptions {
  if (!effort) return EMPTY
  const provider = modelId.split("/")[0]
  switch (provider) {
    case "anthropic": {
      const budgetTokens = THINKING_BUDGET[effort]
      return {
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens } },
        },
        maxOutputTokens: budgetTokens + ANSWER_MARGIN,
      }
    }
    case "openai":
      return { providerOptions: { openai: { reasoningEffort: effort } } }
    case "google":
      return {
        providerOptions: {
          google: {
            thinkingConfig: { thinkingBudget: THINKING_BUDGET[effort] },
          },
        },
      }
    default:
      return EMPTY
  }
}
