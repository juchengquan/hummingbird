import { describe, expect, test } from "bun:test"
import { createSlidingWindow } from "./rate-limit"

describe("createSlidingWindow", () => {
  test("first N calls allowed; (N+1)th refused with retry-after", () => {
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0
    try {
      const limit = createSlidingWindow({ windowMs: 60_000, max: 3 })
      expect(limit.consume("a").allowed).toBe(true)
      expect(limit.consume("a").allowed).toBe(true)
      expect(limit.consume("a").allowed).toBe(true)
      const refused = limit.consume("a")
      expect(refused.allowed).toBe(false)
      expect(refused.retryAfterSec).toBeGreaterThan(0)
      expect(refused.retryAfterSec).toBeLessThanOrEqual(60)
    } finally {
      Date.now = realNow
    }
  })

  test("buckets are per-key (one key's exhaustion doesn't block another)", () => {
    const limit = createSlidingWindow({ windowMs: 60_000, max: 1 })
    expect(limit.consume("a").allowed).toBe(true)
    expect(limit.consume("a").allowed).toBe(false)
    expect(limit.consume("b").allowed).toBe(true)
  })

  test("after the window expires, the key is allowed again", () => {
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0
    try {
      const limit = createSlidingWindow({ windowMs: 60_000, max: 1 })
      expect(limit.consume("a").allowed).toBe(true)
      expect(limit.consume("a").allowed).toBe(false)
      Date.now = () => t0 + 60_001
      expect(limit.consume("a").allowed).toBe(true)
    } finally {
      Date.now = realNow
    }
  })

  test("retryAfterSec reflects the oldest entry's age", () => {
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0
    try {
      const limit = createSlidingWindow({ windowMs: 60_000, max: 1 })
      limit.consume("a")
      Date.now = () => t0 + 30_000
      const refused = limit.consume("a")
      expect(refused.allowed).toBe(false)
      expect(refused.retryAfterSec).toBe(30)
    } finally {
      Date.now = realNow
    }
  })
})
