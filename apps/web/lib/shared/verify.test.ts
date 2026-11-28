import { describe, expect, test } from "bun:test"

import {
  countSupportPerSource,
  parseVerificationFrame,
  summarizeChecks,
} from "./verify"

describe("parseVerificationFrame", () => {
  test("validates checks and recomputes the summary", () => {
    const result = parseVerificationFrame({
      checks: [
        { claim: "A [1].", status: "supported", sourceIds: ["1"] },
        { claim: "B [2].", status: "partial", sourceIds: ["2"] },
      ],
      // A stale/forged summary on the wire is ignored — recomputed.
      summary: { supported: 99, partial: 0, unsupported: 0, total: 99 },
    })
    expect(result?.checks).toHaveLength(2)
    expect(result?.summary).toEqual({
      supported: 1,
      partial: 1,
      unsupported: 0,
      total: 2,
    })
  })

  test("drops malformed checks; all-invalid → null", () => {
    expect(
      parseVerificationFrame({
        checks: [
          { claim: 42, status: "supported" },
          { claim: "ok", status: "bogus" },
        ],
      })
    ).toBeNull()
  })

  test("non-object / missing checks → null", () => {
    expect(parseVerificationFrame(null)).toBeNull()
    expect(parseVerificationFrame({})).toBeNull()
    expect(parseVerificationFrame({ checks: "nope" })).toBeNull()
  })
})

describe("countSupportPerSource", () => {
  test("counts supported claims per source id; ignores partial/unsupported", () => {
    expect(
      countSupportPerSource([
        { claim: "a", status: "supported", sourceIds: ["1", "2"] },
        { claim: "b", status: "supported", sourceIds: ["1"] },
        { claim: "c", status: "partial", sourceIds: ["2"] }, // ignored
        { claim: "d", status: "unsupported", sourceIds: ["3"] }, // ignored
      ])
    ).toEqual({ "1": 2, "2": 1 })
  })

  test("empty / no supported → {}", () => {
    expect(countSupportPerSource([])).toEqual({})
    expect(
      countSupportPerSource([
        { claim: "x", status: "unsupported", sourceIds: ["1"] },
      ])
    ).toEqual({})
  })
})

describe("summarizeChecks", () => {
  test("tallies by status", () => {
    expect(
      summarizeChecks([
        { claim: "a", status: "supported", sourceIds: [] },
        { claim: "b", status: "supported", sourceIds: [] },
        { claim: "c", status: "partial", sourceIds: [] },
        { claim: "d", status: "unsupported", sourceIds: [] },
      ])
    ).toEqual({ supported: 2, partial: 1, unsupported: 1, total: 4 })
  })

  test("empty → all zero", () => {
    expect(summarizeChecks([])).toEqual({
      supported: 0,
      partial: 0,
      unsupported: 0,
      total: 0,
    })
  })
})
