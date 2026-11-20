import { describe, expect, test } from "bun:test"

import { callerScopeFrom } from "./caller-scope"

describe("callerScopeFrom", () => {
  test("signed-in caller → user:<id> (IP irrelevant)", () => {
    expect(callerScopeFrom({ userId: "u-1", clientKey: "1.2.3.4" })).toBe("user:u-1")
    expect(callerScopeFrom({ userId: "u-1", clientKey: "5.6.7.8" })).toBe("user:u-1")
  })

  test("anonymous caller → hashed client key, never the raw IP", () => {
    const scope = callerScopeFrom({ userId: null, clientKey: "1.2.3.4" })
    expect(scope).toMatch(/^anon:[0-9a-f]{32}$/)
    expect(scope).not.toContain("1.2.3.4")
  })

  test("distinct callers get distinct scopes", () => {
    const a = callerScopeFrom({ userId: null, clientKey: "1.2.3.4" })
    const b = callerScopeFrom({ userId: null, clientKey: "5.6.7.8" })
    const u = callerScopeFrom({ userId: "u-1", clientKey: "1.2.3.4" })
    const v = callerScopeFrom({ userId: "u-2", clientKey: "1.2.3.4" })
    expect(new Set([a, b, u, v]).size).toBe(4)
  })

  test("same anonymous client key → stable scope", () => {
    expect(callerScopeFrom({ userId: undefined, clientKey: "1.2.3.4" })).toBe(
      callerScopeFrom({ userId: null, clientKey: "1.2.3.4" }),
    )
  })
})
