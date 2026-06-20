import { describe, expect, test } from "bun:test"

import { matchFactsToForget, shouldOfferMemoryTools } from "./forget-match"

const facts = [
  { id: "f1", fact: "Prefers dark mode" },
  { id: "f2", fact: "Runs Postgres 16 on Hetzner" },
]

describe("matchFactsToForget", () => {
  test("exact match (case-insensitive) → that id", () => {
    expect(matchFactsToForget(facts, "prefers dark mode")).toEqual(["f1"])
  })
  test("no exact but contains (fact contains text) → those ids", () => {
    expect(matchFactsToForget(facts, "dark mode")).toEqual(["f1"])
  })
  test("contains the other direction (text contains fact) → match", () => {
    expect(matchFactsToForget([{ id: "f3", fact: "dark mode" }], "I prefer dark mode")).toEqual(["f3"])
  })
  test("multiple contains matches → all ids", () => {
    // No exact match for "likes tea"; both facts contain it → both ids.
    const f = [{ id: "a", fact: "likes tea a lot" }, { id: "b", fact: "likes tea in the morning" }]
    expect(matchFactsToForget(f, "likes tea").sort()).toEqual(["a", "b"])
  })
  test("exact wins over contains (returns only the exact)", () => {
    const f = [{ id: "a", fact: "tea" }, { id: "b", fact: "tea with milk" }]
    expect(matchFactsToForget(f, "tea")).toEqual(["a"])
  })
  test("no match → []", () => {
    expect(matchFactsToForget(facts, "skydiving")).toEqual([])
  })
  test("whitespace is normalized", () => {
    expect(matchFactsToForget(facts, "  Prefers Dark Mode  ")).toEqual(["f1"])
  })
})

describe("shouldOfferMemoryTools", () => {
  test("true iff enabled && !memoryBypass", () => {
    expect(shouldOfferMemoryTools({ enabled: true, memoryBypass: false })).toBe(true)
    expect(shouldOfferMemoryTools({ enabled: true, memoryBypass: true })).toBe(false)
    expect(shouldOfferMemoryTools({ enabled: false, memoryBypass: false })).toBe(false)
  })
})
