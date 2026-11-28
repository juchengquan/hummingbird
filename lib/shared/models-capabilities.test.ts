import { describe, expect, test } from "bun:test"

import { modelSupportsReasoningEffort } from "./models"

describe("model capability flags", () => {
  test("reasoning effort follows the catalog flag", () => {
    // gpt-5.3-chat: structured output yes, reasoning-effort no.
    expect(modelSupportsReasoningEffort("openai/gpt-5.3-chat")).toBe(false)
  })

  test("unknown model id → false (no crash)", () => {
    expect(modelSupportsReasoningEffort("nope/does-not-exist")).toBe(false)
  })
})
