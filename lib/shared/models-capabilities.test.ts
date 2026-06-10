import { describe, expect, test } from "bun:test"

import {
  modelSupportsReasoningEffort,
  modelSupportsStructuredOutput,
} from "./models"

describe("model capability flags", () => {
  test("structured output is flagged on the hosted families, not local/router", () => {
    expect(modelSupportsStructuredOutput("google/gemini-2.5-flash")).toBe(true)
    expect(modelSupportsStructuredOutput("anthropic/claude-sonnet-4.6")).toBe(
      true
    )
    expect(modelSupportsStructuredOutput("openai/gpt-5.5")).toBe(true)
    // Not flagged — fall back to lenient text parsing.
    expect(modelSupportsStructuredOutput("ollama/llama3.1:8b")).toBe(false)
    expect(modelSupportsStructuredOutput("openrouter/auto")).toBe(false)
    expect(modelSupportsStructuredOutput("minimax/minimax-m2.7")).toBe(false)
  })

  test("reasoning-effort flag is independent of structured-output flag", () => {
    // The default summary/suggestion model supports structured output.
    expect(modelSupportsStructuredOutput("google/gemini-2.5-flash")).toBe(true)
    // gpt-5.3-chat: structured output yes, reasoning-effort no.
    expect(modelSupportsStructuredOutput("openai/gpt-5.3-chat")).toBe(true)
    expect(modelSupportsReasoningEffort("openai/gpt-5.3-chat")).toBe(false)
  })

  test("unknown model id → false (no crash)", () => {
    expect(modelSupportsStructuredOutput("nope/does-not-exist")).toBe(false)
    expect(modelSupportsReasoningEffort("nope/does-not-exist")).toBe(false)
  })
})
