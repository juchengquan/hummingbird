import { describe, expect, test } from "bun:test"

import {
  extractCitedClaims,
  mapRawChecks,
  parseVerificationJson,
  summarizeChecks,
  type CitedClaim,
} from "./verify"

describe("extractCitedClaims", () => {
  test("keeps only sentences carrying a citation marker", () => {
    const answer =
      "The sky is blue. Water boils at 100°C at sea level [1]. This is uncited prose."
    expect(extractCitedClaims(answer)).toEqual([
      { text: "Water boils at 100°C at sea level [1].", citedIndices: [1] },
    ])
  })

  test("collects multiple markers, deduped and ascending", () => {
    const answer = "Revenue grew 12% [3][1] and margins held [1, 2]."
    const claims = extractCitedClaims(answer)
    expect(claims).toHaveLength(1)
    expect(claims[0].citedIndices).toEqual([1, 2, 3])
  })

  test("splits across sentence boundaries and newlines", () => {
    const answer = "First fact [1].\nSecond fact [2]! Third? Fourth fact [3]"
    expect(extractCitedClaims(answer).map((c) => c.citedIndices)).toEqual([
      [1],
      [2],
      [3],
    ])
  })

  test("no citations → empty (the cost-guard signal)", () => {
    expect(extractCitedClaims("A plain answer with no sources.")).toEqual([])
    expect(extractCitedClaims("")).toEqual([])
  })
})

describe("parseVerificationJson", () => {
  test("parses a checks envelope", () => {
    const raw = `{"checks":[{"claim":1,"status":"supported","sourceIds":["1"]},{"claim":2,"status":"unsupported","sourceIds":[]}]}`
    expect(parseVerificationJson(raw)).toEqual([
      { claim: 1, status: "supported", sourceIds: ["1"] },
      { claim: 2, status: "unsupported", sourceIds: [] },
    ])
  })

  test("tolerates markdown fences and a bare array", () => {
    const raw = "```json\n[{\"claim\":1,\"status\":\"partial\",\"sourceIds\":[\"2\"]}]\n```"
    expect(parseVerificationJson(raw)).toEqual([
      { claim: 1, status: "partial", sourceIds: ["2"] },
    ])
  })

  test("drops malformed entries, missing sourceIds default to []", () => {
    const raw = `{"checks":[{"claim":1,"status":"supported"},{"claim":"x","status":"supported"},{"claim":2,"status":"bogus"}]}`
    expect(parseVerificationJson(raw)).toEqual([
      { claim: 1, status: "supported", sourceIds: [] },
    ])
  })

  test("non-JSON → []", () => {
    expect(parseVerificationJson("not json at all")).toEqual([])
  })
})

describe("mapRawChecks", () => {
  const claims: CitedClaim[] = [
    { text: "Claim A [1].", citedIndices: [1] },
    { text: "Claim B [2].", citedIndices: [2] },
  ]

  test("maps 1-based index to claim text", () => {
    expect(
      mapRawChecks(claims, [
        { claim: 2, status: "unsupported", sourceIds: [] },
        { claim: 1, status: "supported", sourceIds: ["1"] },
      ])
    ).toEqual([
      { claim: "Claim B [2].", status: "unsupported", sourceIds: [] },
      { claim: "Claim A [1].", status: "supported", sourceIds: ["1"] },
    ])
  })

  test("drops out-of-range and duplicate indices", () => {
    expect(
      mapRawChecks(claims, [
        { claim: 0, status: "supported", sourceIds: [] },
        { claim: 3, status: "supported", sourceIds: [] },
        { claim: 1, status: "supported", sourceIds: [] },
        { claim: 1, status: "unsupported", sourceIds: [] }, // dup → ignored
      ])
    ).toEqual([{ claim: "Claim A [1].", status: "supported", sourceIds: [] }])
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
