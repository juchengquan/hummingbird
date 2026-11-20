import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { categorizeError } from "@/shared/api-errors"

import {
  assertModelAllowed,
  buildFallbackTable,
  isMinimaxCnConfigured,
  ProviderUnavailableError,
  rejectUnknownModel,
  selectModel,
  UnknownModelError,
} from "./model-provider"

const ENV_KEYS = [
  "AI_GATEWAY_API_KEY",
  "MINIMAX_CN_BASE_URL",
  "MINIMAX_CN_API_KEY",
] as const

function snapshotEnv() {
  const snap: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) snap[k] = process.env[k]
  return snap
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k]
    else process.env[k] = snap[k]
  }
}

describe("selectModel — happy paths", () => {
  let snap: Record<string, string | undefined>
  beforeEach(() => {
    snap = snapshotEnv()
    delete process.env.MINIMAX_CN_BASE_URL
    delete process.env.MINIMAX_CN_API_KEY
    process.env.AI_GATEWAY_API_KEY = "gw-test-key"
  })
  afterEach(() => restoreEnv(snap))

  test("returns a model for a gateway-routed id", () => {
    const m = selectModel("anthropic/claude-sonnet-4.6")
    // LanguageModel is an opaque object — assert we got SOMETHING and
    // selectModel didn't throw. Behavioural assertions live below.
    expect(m).toBeDefined()
  })

  test("returns a model for the multi-route minimax/* id via the gateway fallback", () => {
    const m = selectModel("minimax/minimax-m2.7")
    expect(m).toBeDefined()
  })

})

describe("selectModel — unknown model ids", () => {
  let snap: Record<string, string | undefined>
  beforeEach(() => {
    snap = snapshotEnv()
    delete process.env.MINIMAX_CN_BASE_URL
    delete process.env.MINIMAX_CN_API_KEY
    process.env.AI_GATEWAY_API_KEY = "gw-operator-key"
  })
  afterEach(() => restoreEnv(snap))

  test("rejects an id not in config/models.json (no BYO key)", () => {
    // Would otherwise be billed to the operator's AI_GATEWAY_API_KEY.
    expect(() => selectModel("some/expensive-model")).toThrow(UnknownModelError)
  })

  test("the rejection maps to 400 unknown_model, not a 401/500", () => {
    let err: unknown
    try {
      selectModel("some/expensive-model")
    } catch (e) {
      err = e
    }
    expect(err).not.toBeInstanceOf(ProviderUnavailableError)
    expect(categorizeError(err)).toMatchObject({
      status: 400,
      code: "unknown_model",
    })
  })

  test("a blank BYO key doesn't lift the restriction", () => {
    expect(() =>
      selectModel("some/expensive-model", { gatewayApiKeyOverride: "  " })
    ).toThrow(UnknownModelError)
  })

  test("passes an unknown id through to the gateway with a BYO key", () => {
    const m = selectModel("some/future-model", {
      gatewayApiKeyOverride: "user-key",
    })
    expect(m).toBeDefined()
  })

  test("BYO pass-through works even without an operator gateway key", () => {
    delete process.env.AI_GATEWAY_API_KEY
    const m = selectModel("some/future-model", {
      gatewayApiKeyOverride: "user-key",
    })
    expect(m).toBeDefined()
  })

  test("assertModelAllowed / rejectUnknownModel mirror the rule", async () => {
    expect(() => assertModelAllowed("anthropic/claude-sonnet-4.6")).not.toThrow()
    expect(() => assertModelAllowed("nope/nope")).toThrow(UnknownModelError)
    expect(rejectUnknownModel("anthropic/claude-sonnet-4.6")).toBeNull()
    expect(
      rejectUnknownModel("nope/nope", { gatewayApiKeyOverride: "user-key" })
    ).toBeNull()
    const res = rejectUnknownModel("nope/nope")
    expect(res?.status).toBe(400)
    expect(await res?.json()).toMatchObject({ code: "unknown_model" })
  })
})

describe("selectModel — provider unavailable", () => {
  let snap: Record<string, string | undefined>
  beforeEach(() => {
    snap = snapshotEnv()
    delete process.env.AI_GATEWAY_API_KEY
    delete process.env.MINIMAX_CN_BASE_URL
    delete process.env.MINIMAX_CN_API_KEY
  })
  afterEach(() => restoreEnv(snap))

  test("throws ProviderUnavailableError when no provider is configured", () => {
    expect(() => selectModel("anthropic/claude-sonnet-4.6")).toThrow(
      ProviderUnavailableError
    )
  })

  test("error message mentions tried providers and includes a 401 marker", () => {
    let err: unknown
    try {
      selectModel("minimax/minimax-m2.7")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProviderUnavailableError)
    const msg = (err as Error).message
    expect(msg).toContain("401")
    expect(msg).toContain("minimax-cn")
    expect(msg).toContain("gateway")
  })

  test("gateway override is honoured even when AI_GATEWAY_API_KEY is unset", () => {
    const m = selectModel("anthropic/claude-sonnet-4.6", {
      gatewayApiKeyOverride: "per-request-key",
    })
    expect(m).toBeDefined()
  })

  test("empty override is treated as no override (and still throws)", () => {
    expect(() =>
      selectModel("anthropic/claude-sonnet-4.6", {
        gatewayApiKeyOverride: "   ",
      })
    ).toThrow(ProviderUnavailableError)
  })
})

describe("selectModel — minimax-cn route precedence", () => {
  let snap: Record<string, string | undefined>
  beforeEach(() => {
    snap = snapshotEnv()
    process.env.AI_GATEWAY_API_KEY = "gw-test-key"
    process.env.MINIMAX_CN_BASE_URL = "https://example.test/v1"
    process.env.MINIMAX_CN_API_KEY = "mm-key"
  })
  afterEach(() => restoreEnv(snap))

  test("isMinimaxCnConfigured reports true when both env vars are set", () => {
    expect(isMinimaxCnConfigured()).toBe(true)
  })

  test("non-minimax models still resolve via gateway when both providers are configured", () => {
    const m = selectModel("anthropic/claude-sonnet-4.6")
    expect(m).toBeDefined()
  })

  test("minimax/* model resolves successfully when minimax-cn is configured", () => {
    const m = selectModel("minimax/minimax-m2.7")
    expect(m).toBeDefined()
  })
})

describe("buildFallbackTable — per-provider fallback lookup", () => {
  test("openrouter provider has entries from the bundled config", () => {
    const table = buildFallbackTable("openrouter")
    // The two non-`auto` OpenRouter models in `config/models.json`
    // each declare a fallbacks list — the auto model deliberately
    // doesn't, since OpenRouter's own auto-router covers that case.
    expect(table.get("anthropic/claude-sonnet-4.5")).toEqual([
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5-mini",
    ])
    expect(table.get("openai/gpt-5")).toEqual([
      "openai/gpt-5-mini",
      "anthropic/claude-sonnet-4.5",
    ])
    // openrouter/auto has no fallbacks — OpenRouter's own router
    // does the equivalent on its side.
    expect(table.has("openrouter/auto")).toBe(false)
  })

  test("table is keyed by upstreamId, not by hummingbird model id", () => {
    const table = buildFallbackTable("openrouter")
    // Confirm the wire key is the upstream — the transform reads
    // `body.model` which is what the SDK sends.
    expect(table.has("anthropic/claude-sonnet-4.5")).toBe(true)
    expect(table.has("openrouter/anthropic/claude-sonnet-4.5")).toBe(false)
  })

  test("provider with no fallback-bearing routes returns an empty table", () => {
    // Ollama models in the bundled config have single-route routes
    // with no fallbacks. The hook short-circuits when the table is
    // empty, so this is the "no-op" case that costs nothing.
    expect(buildFallbackTable("ollama").size).toBe(0)
  })

  test("unknown provider name returns an empty table", () => {
    expect(buildFallbackTable("does-not-exist").size).toBe(0)
  })

  test("returned arrays are copies — caller mutation can't poison the registry", () => {
    const table = buildFallbackTable("openrouter")
    const list = table.get("anthropic/claude-sonnet-4.5")!
    list.push("attacker/injected")
    const fresh = buildFallbackTable("openrouter")
    expect(fresh.get("anthropic/claude-sonnet-4.5")).toEqual([
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5-mini",
    ])
  })
})

describe("isMinimaxCnConfigured", () => {
  let snap: Record<string, string | undefined>
  beforeEach(() => {
    snap = snapshotEnv()
    delete process.env.MINIMAX_CN_BASE_URL
    delete process.env.MINIMAX_CN_API_KEY
  })
  afterEach(() => restoreEnv(snap))

  test("false when neither env var is set", () => {
    expect(isMinimaxCnConfigured()).toBe(false)
  })

  test("false when only one of the two env vars is set", () => {
    process.env.MINIMAX_CN_BASE_URL = "https://example.test/v1"
    expect(isMinimaxCnConfigured()).toBe(false)
    delete process.env.MINIMAX_CN_BASE_URL
    process.env.MINIMAX_CN_API_KEY = "k"
    expect(isMinimaxCnConfigured()).toBe(false)
  })
})
