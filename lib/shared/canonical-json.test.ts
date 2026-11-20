import { describe, expect, test } from "bun:test"

import { canonicalJson } from "./canonical-json"

describe("canonicalJson", () => {
  test("sorts keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe(
      '{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}'
    )
  })

  test("is insertion-order independent", () => {
    expect(canonicalJson({ x: 1, y: { p: 1, q: 2 } })).toBe(
      canonicalJson({ y: { q: 2, p: 1 }, x: 1 })
    )
  })

  test("keeps nested keys absent from the top level (the whitelist bug)", () => {
    const cred = { type: "bearer", headers: { authorization: "Bearer abc" } }
    expect(canonicalJson(cred)).toContain("Bearer abc")
    // The old implementation dropped them:
    expect(JSON.stringify(cred, Object.keys(cred).sort())).toBe(
      '{"headers":{},"type":"bearer"}'
    )
  })

  test("matches JSON.stringify semantics for undefined, null and Dates", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
    expect(canonicalJson([undefined, 1])).toBe("[null,1]")
    expect(canonicalJson({ d: new Date("2024-01-02T03:04:05.000Z") })).toBe(
      '{"d":"2024-01-02T03:04:05.000Z"}'
    )
    expect(canonicalJson("s")).toBe('"s"')
  })
})
