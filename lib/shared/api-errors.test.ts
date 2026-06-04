import { describe, expect, test } from "bun:test"

import { categorizeError } from "./api-errors"

/**
 * Tests for the AI Gateway-side error categoriser used by the
 * Next.js `/api/chat` route. Mirrors the priority order in the
 * `services/agent-py/src/agent_py/chat.py:categorize_provider_error`
 * and `services/agent-ts/src/chat.ts:categorizeProviderError` helpers
 * so all three backends label the same surface the same way.
 */

describe("categorizeError", () => {
  test("AbortError → aborted (408)", () => {
    const err = new Error("aborted")
    err.name = "AbortError"
    const out = categorizeError(err)
    expect(out.code).toBe("aborted")
    expect(out.status).toBe(408)
  })

  test("rate-limit phrasing → rate_limit (429)", () => {
    expect(categorizeError(new Error("Rate limit exceeded")).code).toBe(
      "rate_limit",
    )
    expect(categorizeError(new Error("429")).code).toBe("rate_limit")
    expect(categorizeError(new Error("too many requests")).code).toBe(
      "rate_limit",
    )
  })

  test("context-window phrasing → context_window (400)", () => {
    expect(categorizeError(new Error("prompt is too long")).code).toBe(
      "context_window",
    )
    expect(categorizeError(new Error("context length exceeded")).code).toBe(
      "context_window",
    )
    expect(categorizeError(new Error("input is too long")).code).toBe(
      "context_window",
    )
    expect(categorizeError(new Error("context window full")).code).toBe(
      "context_window",
    )
    expect(categorizeError(new Error("exceeds 200000 token limit")).code).toBe(
      "context_window",
    )
  })

  test("invalid-model phrasing → invalid_model (400)", () => {
    expect(categorizeError(new Error("invalid model id")).code).toBe(
      "invalid_model",
    )
    expect(categorizeError(new Error("model not found")).code).toBe(
      "invalid_model",
    )
    // Generic 400 falls through to invalid_model when no other branch
    // claims it.
    expect(categorizeError(new Error("HTTP 400 Bad Request")).code).toBe(
      "invalid_model",
    )
  })

  test("auth phrasing → auth (401)", () => {
    expect(categorizeError(new Error("Unauthorized")).code).toBe("auth")
    expect(categorizeError(new Error("401")).code).toBe("auth")
    expect(categorizeError(new Error("403 Forbidden")).code).toBe("auth")
  })

  test("provider phrasing → provider (502)", () => {
    expect(categorizeError(new Error("Bad Gateway")).code).toBe("provider")
    expect(categorizeError(new Error("502 upstream")).code).toBe("provider")
    expect(categorizeError(new Error("503 Service Unavailable")).code).toBe(
      "provider",
    )
  })

  test("anything else → unknown (500)", () => {
    expect(categorizeError(new Error("connection reset")).code).toBe("unknown")
    expect(categorizeError("a plain string").code).toBe("unknown")
  })

  test("context_window wins over invalid_model when a 400 mentions both", () => {
    // The two branches BOTH match this message; the order in the
    // categoriser puts context_window first so the consumer sees the
    // more specific surface.
    const out = categorizeError(new Error("prompt is too long: HTTP 400"))
    expect(out.code).toBe("context_window")
  })
})
