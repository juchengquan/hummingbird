import { describe, expect, test } from "bun:test"

import { extractCacheKey } from "./route"

describe("extract cache key", () => {
  test("vision flag changes the key", () => {
    const base = { name: "a.pdf", mimeType: "application/pdf", contentHash: "abc" }
    expect(extractCacheKey({ ...base, vision: true })).not.toBe(
      extractCacheKey({ ...base, vision: false })
    )
  })
  test("same inputs → same key", () => {
    const a = { name: "a.pdf", mimeType: "application/pdf", contentHash: "abc", vision: true }
    expect(extractCacheKey(a)).toBe(extractCacheKey({ ...a }))
  })
})
