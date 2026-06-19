import { describe, expect, test } from "bun:test"

import { mergeFacts } from "./merge"
import type { MemoryFact } from "./types"

const existing: MemoryFact[] = [
  { id: "f1", fact: "Runs Postgres 16", category: "stack" },
]

describe("mergeFacts", () => {
  test("add → insert", () => {
    const r = mergeFacts(existing, [{ op: "add", fact: "Prefers TypeScript", category: "preference" }])
    expect(r.inserts).toEqual([{ fact: "Prefers TypeScript", category: "preference" }])
    expect(r.updates).toEqual([])
  })
  test("update with a valid existing id → update", () => {
    const r = mergeFacts(existing, [{ op: "update", id: "f1", fact: "Runs Postgres 17", category: "stack" }])
    expect(r.updates).toEqual([{ id: "f1", fact: "Runs Postgres 17", category: "stack" }])
    expect(r.inserts).toEqual([])
  })
  test("update with an unknown id is dropped (no insert, no update)", () => {
    const r = mergeFacts(existing, [{ op: "update", id: "nope", fact: "x" }])
    expect(r.inserts).toEqual([])
    expect(r.updates).toEqual([])
  })
  test("inserts respect the cap (existing + inserts ≤ MEMORY_FACT_CAP)", () => {
    const many: MemoryFact[] = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, fact: `f${i}`, category: null }))
    const r = mergeFacts(many, [{ op: "add", fact: "overflow" }])
    expect(r.inserts).toEqual([]) // already at cap
  })
  test("category defaults to null when omitted", () => {
    const r = mergeFacts([], [{ op: "add", fact: "solo" }])
    expect(r.inserts[0]).toEqual({ fact: "solo", category: null })
  })
})
