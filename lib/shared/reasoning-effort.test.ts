import { describe, expect, test } from "bun:test"

import {
  isReasoningEffort,
  reasoningCallOptions,
  REASONING_EFFORTS,
} from "./reasoning-effort"

describe("reasoningCallOptions", () => {
  test("null / undefined effort → empty (safe to spread)", () => {
    expect(reasoningCallOptions("anthropic/claude-sonnet-4.6", null)).toEqual({
      providerOptions: {},
    })
    expect(
      reasoningCallOptions("anthropic/claude-sonnet-4.6", undefined)
    ).toEqual({ providerOptions: {} })
  })

  test("anthropic → thinking budget + matching maxOutputTokens", () => {
    const out = reasoningCallOptions("anthropic/claude-sonnet-4.6", "high")
    expect(out.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
    })
    // max_tokens must exceed the thinking budget.
    expect(out.maxOutputTokens).toBeGreaterThan(16384)
  })

  test("anthropic budgets scale with the tier", () => {
    const low = reasoningCallOptions("anthropic/claude-haiku-4.5", "low")
    const med = reasoningCallOptions("anthropic/claude-haiku-4.5", "medium")
    const high = reasoningCallOptions("anthropic/claude-haiku-4.5", "high")
    const budget = (o: ReturnType<typeof reasoningCallOptions>) =>
      (o.providerOptions.anthropic as { thinking: { budgetTokens: number } })
        .thinking.budgetTokens
    expect(budget(low)).toBeLessThan(budget(med))
    expect(budget(med)).toBeLessThan(budget(high))
  })

  test("openai → reasoningEffort string, no maxOutputTokens", () => {
    const out = reasoningCallOptions("openai/gpt-5.5", "medium")
    expect(out.providerOptions).toEqual({
      openai: { reasoningEffort: "medium" },
    })
    expect(out.maxOutputTokens).toBeUndefined()
  })

  test("google → thinkingConfig budget, no maxOutputTokens", () => {
    const out = reasoningCallOptions("google/gemini-2.5-flash", "low")
    expect(out.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingBudget: 2048 } },
    })
    expect(out.maxOutputTokens).toBeUndefined()
  })

  test("unmapped providers → empty (no options sent)", () => {
    for (const id of [
      "ollama/llama3.1:8b",
      "openrouter/auto",
      "minimax/minimax-m2.7",
      "deepseek/deepseek-v4-flash",
    ]) {
      expect(reasoningCallOptions(id, "high")).toEqual({ providerOptions: {} })
    }
  })
})

describe("isReasoningEffort", () => {
  test("accepts the three tiers, rejects everything else", () => {
    for (const e of REASONING_EFFORTS) expect(isReasoningEffort(e)).toBe(true)
    for (const bad of ["", "auto", "off", null, undefined, 1, {}])
      expect(isReasoningEffort(bad)).toBe(false)
  })
})
