import { afterEach, describe, expect, test } from "bun:test"

import {
  __clearResponseCache,
  __expireEntry,
  cosine,
  findSimilarCachedResponse,
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

describe("cosine", () => {
  test("identical vectors → 1", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10)
  })
  test("orthogonal vectors → 0", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10)
  })
  test("length mismatch → -1 (no match)", () => {
    expect(cosine([1, 0, 0], [1, 0])).toBe(-1)
  })
  test("zero vector → -1 (no match)", () => {
    expect(cosine([0, 0], [1, 0])).toBe(-1)
  })
})

describe("findSimilarCachedResponse", () => {
  const SCOPE = "summarize|file|m"

  test("returns the value of an entry above the threshold", () => {
    setCachedResponse("k1", "summary-A", { embedding: [1, 0, 0], scope: SCOPE })
    const hit = findSimilarCachedResponse<string>({
      scope: SCOPE,
      embedding: [1, 0, 0],
    })
    expect(hit).toBe("summary-A")
  })

  test("misses when cosine is below the threshold", () => {
    setCachedResponse("k1", "summary-A", { embedding: [1, 0, 0], scope: SCOPE })
    const hit = findSimilarCachedResponse<string>({
      scope: SCOPE,
      embedding: [0, 1, 0],
    })
    expect(hit).toBeUndefined()
  })

  test("respects an explicit threshold (boundary)", () => {
    const near: number[] = [0.95, Math.sqrt(1 - 0.95 * 0.95), 0]
    setCachedResponse("k1", "summary-A", { embedding: [1, 0, 0], scope: SCOPE })
    expect(
      findSimilarCachedResponse<string>({ scope: SCOPE, embedding: near, threshold: 0.9 }),
    ).toBe("summary-A")
    expect(
      findSimilarCachedResponse<string>({ scope: SCOPE, embedding: near, threshold: 0.97 }),
    ).toBeUndefined()
  })

  test("does not match across scope", () => {
    setCachedResponse("k1", "summary-A", { embedding: [1, 0, 0], scope: SCOPE })
    expect(
      findSimilarCachedResponse<string>({
        scope: "summarize|file|other-model",
        embedding: [1, 0, 0],
      }),
    ).toBeUndefined()
  })

  test("ignores entries stored without an embedding (2-arg setCachedResponse)", () => {
    setCachedResponse("k1", "plain")
    expect(
      findSimilarCachedResponse<string>({ scope: SCOPE, embedding: [1, 0, 0] }),
    ).toBeUndefined()
  })

  test("picks the highest-scoring entry when several qualify", () => {
    setCachedResponse("k1", "far", { embedding: [0.98, 0.199, 0], scope: SCOPE })
    setCachedResponse("k2", "near", { embedding: [1, 0, 0], scope: SCOPE })
    expect(
      findSimilarCachedResponse<string>({ scope: SCOPE, embedding: [1, 0, 0] }),
    ).toBe("near")
  })

  test("drops an expired entry during the scan and does not return it", () => {
    setCachedResponse("k1", "stale", { embedding: [1, 0, 0], scope: SCOPE })
    __expireEntry("k1")
    expect(
      findSimilarCachedResponse<string>({ scope: SCOPE, embedding: [1, 0, 0] }),
    ).toBeUndefined()
    // The expired entry was evicted by the scan, not merely skipped.
    expect(getCachedResponse("k1")).toBeUndefined()
  })
})
