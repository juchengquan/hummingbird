import { afterEach, describe, expect, test } from "bun:test"

import {
  __clearResponseCache,
  getCachedResponse,
  responseCacheKey,
  setCachedResponse,
} from "./response-cache"

afterEach(() => __clearResponseCache())

describe("responseCacheKey", () => {
  test("same logical input → same key, regardless of object key order", () => {
    const a = responseCacheKey({
      kind: "summarize",
      model: "google/gemini-2.5-flash",
      input: { name: "doc", text: "hello" },
    })
    const b = responseCacheKey({
      kind: "summarize",
      model: "google/gemini-2.5-flash",
      input: { text: "hello", name: "doc" },
    })
    expect(a).toBe(b)
  })

  test("array order is significant (message order matters)", () => {
    const k = (msgs: string[]) =>
      responseCacheKey({ kind: "summarize", model: "m", input: { msgs } })
    expect(k(["a", "b"])).not.toBe(k(["b", "a"]))
  })

  test("model, kind, and input each change the key", () => {
    const base = { kind: "summarize", model: "m1", input: { text: "x" } }
    const key = responseCacheKey(base)
    expect(responseCacheKey({ ...base, model: "m2" })).not.toBe(key)
    expect(responseCacheKey({ ...base, kind: "extract" })).not.toBe(key)
    expect(
      responseCacheKey({ ...base, input: { text: "y" } })
    ).not.toBe(key)
  })

  test("keys are fixed-length hex (hashed, not the raw input)", () => {
    const key = responseCacheKey({
      kind: "summarize",
      model: "m",
      input: { text: "x".repeat(100_000) },
    })
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("get / set", () => {
  test("round-trips a stored value", () => {
    const key = responseCacheKey({ kind: "k", model: "m", input: { a: 1 } })
    expect(getCachedResponse(key)).toBeUndefined()
    setCachedResponse(key, { summary: "cached" })
    expect(getCachedResponse<{ summary: string }>(key)).toEqual({
      summary: "cached",
    })
  })

  test("distinct keys don't collide", () => {
    const k1 = responseCacheKey({ kind: "k", model: "m", input: { a: 1 } })
    const k2 = responseCacheKey({ kind: "k", model: "m", input: { a: 2 } })
    setCachedResponse(k1, "one")
    setCachedResponse(k2, "two")
    expect(getCachedResponse<string>(k1)).toBe("one")
    expect(getCachedResponse<string>(k2)).toBe("two")
  })

  test("overwrites an existing key", () => {
    const key = responseCacheKey({ kind: "k", model: "m", input: { a: 1 } })
    setCachedResponse(key, "first")
    setCachedResponse(key, "second")
    expect(getCachedResponse<string>(key)).toBe("second")
  })
})
