/**
 * Reasoning-effort tiers the chat header offers for models with a
 * thinking-budget / reasoning-effort knob; the run carries the choice to
 * agent-py, which maps it onto the provider. The capability gate
 * (`modelSupportsReasoningEffort`) lives in `@/shared/models` because it
 * reads `config/models.json`.
 */

export type ReasoningEffort = "low" | "medium" | "high"

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
]
