import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  isMinimaxCnConfigured,
  ProviderUnavailableError,
  selectModel,
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

  test("falls back to gateway for an unknown model id", () => {
    // Unknown ids implicitly route through the gateway — preserves the
    // pre-refactor behaviour for per-request overrides that bypass
    // config/models.json.
    const m = selectModel("some/future-model")
    expect(m).toBeDefined()
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
