import { describe, expect, test } from "bun:test"

import {
  ANTHROPIC_SERVICE_MODELS,
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  getAnthropicApiModelId,
  getChatModel,
  modelSupportsVision,
} from "./models"

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

describe("agent-service allowlist (anthropic/* entries)", () => {
  test("maps catalog ids to Anthropic API ids (dash, not dot)", () => {
    expect(getAnthropicApiModelId("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4-6")
    expect(getAnthropicApiModelId("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4-5")
  })

  test("non-anthropic catalog ids and unknown ids are not allowed", () => {
    expect(getAnthropicApiModelId("deepseek/deepseek-v4-flash")).toBeNull()
    expect(getAnthropicApiModelId("openrouter/anthropic/claude-sonnet-4.5")).toBeNull()
    expect(getAnthropicApiModelId("claude-sonnet-4-6")).toBeNull()
    expect(getAnthropicApiModelId("anthropic/claude-opus-9")).toBeNull()
  })

  test("every anthropic/* entry carries an explicit API id", () => {
    // The stripped catalog id (`claude-sonnet-4.6`) is NOT a valid
    // Anthropic API id, so each entry must set `anthropicModelId`.
    const entries = CHAT_MODELS.filter((m) => m.id.startsWith("anthropic/"))
    expect(entries.length).toBe(ANTHROPIC_SERVICE_MODELS.size)
    for (const m of entries) {
      expect(m.anthropicModelId).toMatch(/^claude-[a-z0-9-]+$/)
    }
  })
})
