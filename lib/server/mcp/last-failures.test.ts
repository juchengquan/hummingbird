import { afterEach, describe, expect, test } from "bun:test"
import {
  _resetForTests,
  clearFailure,
  getRecentFailure,
  recordFailure,
} from "./last-failures"

afterEach(() => _resetForTests())

describe("last-failures cache", () => {
  test("empty cache → null", () => {
    expect(getRecentFailure("srv-1")).toBeNull()
  })

  test("fresh recording → cached reason", () => {
    recordFailure("srv-1", "timed out after 5000ms")
    expect(getRecentFailure("srv-1")).toBe("timed out after 5000ms")
  })

  test("other server unaffected", () => {
    recordFailure("srv-1", "boom")
    expect(getRecentFailure("srv-2")).toBeNull()
  })

  test("re-record overwrites", () => {
    recordFailure("srv-1", "first")
    recordFailure("srv-1", "second")
    expect(getRecentFailure("srv-1")).toBe("second")
  })

  test("clearFailure removes the entry", () => {
    recordFailure("srv-1", "boom")
    clearFailure("srv-1")
    expect(getRecentFailure("srv-1")).toBeNull()
  })

  test("entry past 30s TTL → null (lazy expiry)", () => {
    // Freeze the clock so the record and read see fixed timestamps —
    // without this the few microseconds between `recordFailure` and
    // the patch leak into the diff and make the boundary check flaky
    // when the suite runs under load.
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0
    try {
      recordFailure("srv-3", "test")
      Date.now = () => t0 + 31_000
      expect(getRecentFailure("srv-3")).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  test("at exactly 30s boundary → still cached", () => {
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0
    try {
      recordFailure("srv-4", "edge")
      Date.now = () => t0 + 30_000
      expect(getRecentFailure("srv-4")).toBe("edge")
    } finally {
      Date.now = realNow
    }
  })

  test("subsequent reads hit the cache (idempotent)", () => {
    recordFailure("srv-5", "unreachable")
    expect(getRecentFailure("srv-5")).toBe("unreachable")
    expect(getRecentFailure("srv-5")).toBe("unreachable")
  })
})
