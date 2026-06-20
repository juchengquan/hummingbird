import { describe, expect, test } from "bun:test"

import { CHAT_MODELS, DEFAULT_CHAT_MODEL, getChatModel, modelSupportsVision } from "./models"

describe("CHAT_MODELS — loaded from config/models.json", () => {
  test("contains at least the bundled default models", () => {
    const ids = CHAT_MODELS.map((m) => m.id)
    expect(ids).toContain("anthropic/claude-sonnet-4.6")
    expect(ids).toContain("minimax/minimax-m2.7")
    expect(ids).toContain("deepseek/deepseek-v4-flash")
  })

  test("every entry validates the schema shape", () => {
    for (const m of CHAT_MODELS) {
      expect(typeof m.id).toBe("string")
      expect(typeof m.label).toBe("string")
      expect(typeof m.provider).toBe("string")
      expect(typeof m.contextWindow).toBe("number")
      expect(m.contextWindow).toBeGreaterThan(0)
      expect(Array.isArray(m.routes)).toBe(true)
      expect(m.routes.length).toBeGreaterThan(0)
      for (const r of m.routes) {
        expect(typeof r.via).toBe("string")
        if (r.upstreamId !== undefined) {
          expect(typeof r.upstreamId).toBe("string")
        }
      }
    }
  })

  test("DEFAULT_CHAT_MODEL points at a real entry", () => {
    expect(CHAT_MODELS.some((m) => m.id === DEFAULT_CHAT_MODEL)).toBe(true)
  })

  test("minimax route prefers minimax-cn over gateway", () => {
    const mm = CHAT_MODELS.find((m) => m.id === "minimax/minimax-m2.7")
    expect(mm).toBeDefined()
    expect(mm?.routes[0]?.via).toBe("minimax-cn")
    expect(mm?.routes[0]?.upstreamId).toBe("minimax-m2.7")
    expect(mm?.routes[1]?.via).toBe("gateway")
  })
})

describe("getChatModel", () => {
  test("returns the entry for a known id", () => {
    const m = getChatModel("anthropic/claude-sonnet-4.6")
    expect(m).not.toBeNull()
    expect(m?.label).toBe("Claude Sonnet 4.6")
  })

  test("returns null for an unknown id", () => {
    expect(getChatModel("does/not-exist")).toBeNull()
  })
})

describe("modelSupportsVision", () => {
  test("flagged model → true", () => {
    expect(modelSupportsVision("anthropic/claude-sonnet-4.6")).toBe(true)
  })
  test("unflagged model → false", () => {
    expect(modelSupportsVision("deepseek/deepseek-v4-flash")).toBe(false)
  })
  test("unknown id → false", () => {
    expect(modelSupportsVision("does/not-exist")).toBe(false)
  })
})
