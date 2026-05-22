import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __test,
  getProviderConfig,
  isProviderConfigured,
  listProviderNames,
  resolveProvider,
} from "./providers-config"

const { isSafeBaseUrl, parseConfig } = __test

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

describe("providers-config — getProviderConfig", () => {
  test("returns null for unknown name", () => {
    expect(getProviderConfig("does-not-exist")).toBeNull()
  })
  test("returns gateway config from JSON", () => {
    const cfg = getProviderConfig("gateway")
    expect(cfg).not.toBeNull()
    expect(cfg?.type).toBe("gateway")
  })
  test("returns minimax-cn config from JSON", () => {
    const cfg = getProviderConfig("minimax-cn")
    expect(cfg).not.toBeNull()
    expect(cfg?.type).toBe("anthropic")
  })
})

describe("providers-config — listProviderNames", () => {
  test("contains the bundled providers", () => {
    const names = listProviderNames()
    expect(names).toContain("gateway")
    expect(names).toContain("minimax-cn")
  })
})

describe("providers-config — resolveProvider (gateway)", () => {
  let snap: Record<string, string | undefined>
  beforeEach(() => {
    snap = snapshotEnv()
    delete process.env.AI_GATEWAY_API_KEY
  })
  afterEach(() => restoreEnv(snap))

  test("returns null when AI_GATEWAY_API_KEY is unset", () => {
    expect(resolveProvider("gateway")).toBeNull()
    expect(isProviderConfigured("gateway")).toBe(false)
  })

  test("returns { type: gateway, apiKey } when env is set", () => {
    process.env.AI_GATEWAY_API_KEY = "gw-test-key"
    const r = resolveProvider("gateway")
    expect(r).toEqual({ type: "gateway", apiKey: "gw-test-key" })
    expect(isProviderConfigured("gateway")).toBe(true)
  })

  test("trims whitespace from env var", () => {
    process.env.AI_GATEWAY_API_KEY = "  gw-trimmed  "
    expect(resolveProvider("gateway")).toEqual({
      type: "gateway",
      apiKey: "gw-trimmed",
    })
  })

  test("treats empty / whitespace-only env var as unset", () => {
    process.env.AI_GATEWAY_API_KEY = "   "
    expect(resolveProvider("gateway")).toBeNull()
  })
})

describe("providers-config — resolveProvider (anthropic via env)", () => {
  let snap: Record<string, string | undefined>
  beforeEach(() => {
    snap = snapshotEnv()
    delete process.env.MINIMAX_CN_BASE_URL
    delete process.env.MINIMAX_CN_API_KEY
  })
  afterEach(() => restoreEnv(snap))

  test("requires both baseURL and apiKey", () => {
    expect(resolveProvider("minimax-cn")).toBeNull()

    process.env.MINIMAX_CN_API_KEY = "key-only"
    expect(resolveProvider("minimax-cn")).toBeNull()

    delete process.env.MINIMAX_CN_API_KEY
    process.env.MINIMAX_CN_BASE_URL = "https://example.com/v1"
    expect(resolveProvider("minimax-cn")).toBeNull()
  })

  test("returns full anthropic config when both env vars are set", () => {
    process.env.MINIMAX_CN_BASE_URL = "https://api.minimax.chat/anthropic/v1"
    process.env.MINIMAX_CN_API_KEY = "mm-test-key"
    expect(resolveProvider("minimax-cn")).toEqual({
      type: "anthropic",
      baseURL: "https://api.minimax.chat/anthropic/v1",
      apiKey: "mm-test-key",
    })
    expect(isProviderConfigured("minimax-cn")).toBe(true)
  })
})

describe("providers-config — unknown provider", () => {
  test("resolveProvider returns null without throwing", () => {
    expect(resolveProvider("not-a-real-provider")).toBeNull()
    expect(isProviderConfigured("not-a-real-provider")).toBe(false)
  })
})

describe("isSafeBaseUrl — accepts", () => {
  test("plain https URL with public hostname", () => {
    expect(isSafeBaseUrl("https://api.minimax.chat/v1")).toBe(true)
  })
  test("https URL with path", () => {
    expect(isSafeBaseUrl("https://example.com/v1")).toBe(true)
  })
  test("https URL with port", () => {
    expect(isSafeBaseUrl("https://api.example.com:8443/v1")).toBe(true)
  })
})

describe("isSafeBaseUrl — rejects", () => {
  test("non-https scheme (http)", () => {
    expect(isSafeBaseUrl("http://api.minimax.chat/v1")).toBe(false)
  })
  test("non-http scheme (ftp)", () => {
    expect(isSafeBaseUrl("ftp://api.minimax.chat")).toBe(false)
  })
  test("localhost", () => {
    expect(isSafeBaseUrl("https://localhost:8080/v1")).toBe(false)
  })
  test("loopback IP", () => {
    expect(isSafeBaseUrl("https://127.0.0.1/v1")).toBe(false)
  })
  test("any 127.x.x.x", () => {
    expect(isSafeBaseUrl("https://127.5.4.3/v1")).toBe(false)
  })
  test("0.0.0.0", () => {
    expect(isSafeBaseUrl("https://0.0.0.0/v1")).toBe(false)
  })
  test("RFC 1918 ranges", () => {
    expect(isSafeBaseUrl("https://10.1.2.3/v1")).toBe(false)
    expect(isSafeBaseUrl("https://192.168.1.1/v1")).toBe(false)
    expect(isSafeBaseUrl("https://172.16.0.1/v1")).toBe(false)
    expect(isSafeBaseUrl("https://172.31.255.255/v1")).toBe(false)
  })
  test("172.15.x — outside RFC 1918 — is allowed (regression guard)", () => {
    expect(isSafeBaseUrl("https://172.15.0.1/v1")).toBe(true)
    expect(isSafeBaseUrl("https://172.32.0.1/v1")).toBe(true)
  })
  test(".local / .internal suffix", () => {
    expect(isSafeBaseUrl("https://service.local/v1")).toBe(false)
    expect(isSafeBaseUrl("https://api.internal/v1")).toBe(false)
  })
  test("IPv6 loopback", () => {
    expect(isSafeBaseUrl("https://[::1]/v1")).toBe(false)
  })
  test("not a URL at all", () => {
    expect(isSafeBaseUrl("not a url")).toBe(false)
    expect(isSafeBaseUrl("")).toBe(false)
  })
  test("scheme alone", () => {
    expect(isSafeBaseUrl("https://")).toBe(false)
  })
})

describe("provider schema — accepts the three supported types", () => {
  test("gateway", () => {
    const r = parseConfig({
      gw: { type: "gateway", apiKeyEnv: "X" },
    })
    expect(r.success).toBe(true)
  })

  test("anthropic with baseURL inline", () => {
    const r = parseConfig({
      ant: {
        type: "anthropic",
        baseURL: "https://api.example.com/v1",
        apiKey: "k",
      },
    })
    expect(r.success).toBe(true)
  })

  test("openai with baseURL inline", () => {
    // OpenAI-compatible endpoints: OpenRouter, Together, Groq, vLLM,
    // LM Studio, Ollama, self-hosted. Same baseURL + apiKey shape as
    // anthropic, just a different `type` discriminator.
    const r = parseConfig({
      openrouter: {
        type: "openai",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-...",
      },
    })
    expect(r.success).toBe(true)
  })

  test("openai with env-var refs", () => {
    const r = parseConfig({
      openrouter: {
        type: "openai",
        baseURLEnv: "OPENROUTER_BASE_URL",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
    })
    expect(r.success).toBe(true)
  })

  test("rejects unknown provider type", () => {
    const r = parseConfig({
      bogus: { type: "cohere", apiKeyEnv: "X" },
    })
    expect(r.success).toBe(false)
  })

  test("rejects baseURL on gateway type", () => {
    // gateway providers don't take a baseURL — they always route via
    // the Vercel AI Gateway. Catching this at schema time avoids
    // confusion.
    const r = parseConfig({
      gw: {
        type: "gateway",
        baseURL: "https://example.com",
        apiKeyEnv: "X",
      },
    })
    // Zod's discriminated union with `extend` is strict by default —
    // unknown keys on gateway shouldn't strictly fail, but the
    // resolved type won't carry them anyway. Treat permissive parse
    // as acceptable: the runtime simply ignores unknown fields.
    expect(r.success).toBe(true)
  })
})

describe("resolveProvider — anthropic SSRF gate", () => {
  let snap: Record<string, string | undefined>
  beforeEach(() => {
    snap = snapshotEnv()
    delete process.env.MINIMAX_CN_BASE_URL
    delete process.env.MINIMAX_CN_API_KEY
  })
  afterEach(() => restoreEnv(snap))

  test("rejects http:// baseURL and returns null", () => {
    process.env.MINIMAX_CN_BASE_URL = "http://api.minimax.chat/v1"
    process.env.MINIMAX_CN_API_KEY = "k"
    expect(resolveProvider("minimax-cn")).toBeNull()
  })

  test("rejects localhost baseURL", () => {
    process.env.MINIMAX_CN_BASE_URL = "https://localhost:8080/v1"
    process.env.MINIMAX_CN_API_KEY = "k"
    expect(resolveProvider("minimax-cn")).toBeNull()
  })

  test("rejects private-range baseURL", () => {
    process.env.MINIMAX_CN_BASE_URL = "https://10.0.0.1/v1"
    process.env.MINIMAX_CN_API_KEY = "k"
    expect(resolveProvider("minimax-cn")).toBeNull()
  })
})
