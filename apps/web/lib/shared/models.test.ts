import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import bundledCatalog from "@config/models.json"

import {
  ANTHROPIC_SERVICE_MODELS,
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  getChatModel,
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

const apiIdOf = (id: string) => ANTHROPIC_SERVICE_MODELS.get(id) ?? null

describe("agent-service allowlist (anthropic/* entries)", () => {
  test("maps catalog ids to Anthropic API ids (dash, not dot)", () => {
    expect(apiIdOf("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4-6")
    expect(apiIdOf("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4-5")
  })

  test("non-anthropic catalog ids and unknown ids are not allowed", () => {
    expect(apiIdOf("deepseek/deepseek-v4-flash")).toBeNull()
    expect(apiIdOf("openrouter/anthropic/claude-sonnet-4.5")).toBeNull()
    expect(apiIdOf("claude-sonnet-4-6")).toBeNull()
    expect(apiIdOf("anthropic/claude-opus-9")).toBeNull()
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

// Q153: one catalog for both halves. The web app bundles the repo root's
// config/models.json through `@config/*`; agent-py reads the same file
// (services/agent-py/tests/test_model_allowlist.py pins its side).
describe("the catalog is the repo root's config/models.json", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..")

  test("@config/models.json is that file, not a copy", () => {
    const onDisk = JSON.parse(readFileSync(join(repoRoot, "config", "models.json"), "utf8"))
    expect(bundledCatalog).toEqual(onDisk)
  })

  test("apps/web keeps no catalog of its own", () => {
    expect(existsSync(join(repoRoot, "apps", "web", "config"))).toBe(false)
  })

  test("the alias points at the root's config/", () => {
    const tsconfig = readFileSync(join(repoRoot, "apps", "web", "tsconfig.json"), "utf8")
    expect(tsconfig).toContain('"@config/*": ["../../config/*"]')
  })
})
