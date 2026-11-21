import { describe, expect, test } from "bun:test"

import { shareReadsFromBackend } from "./share-backend"

describe("shareReadsFromBackend", () => {
  test("absolute backend URL → backend", () => {
    expect(shareReadsFromBackend("http://localhost:8000")).toBe(true)
  })
  test("same origin `/` → backend", () => {
    expect(shareReadsFromBackend("/")).toBe(true)
  })
  test("unset / blank → server path", () => {
    expect(shareReadsFromBackend(undefined)).toBe(false)
    expect(shareReadsFromBackend(null)).toBe(false)
    expect(shareReadsFromBackend("   ")).toBe(false)
  })
})
