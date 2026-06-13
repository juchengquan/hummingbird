import { describe, expect, test } from "bun:test"

import {
  markerMarksFor,
  type ClaimCheck,
  type VerificationResult,
} from "./verify"

const check = (over: Partial<ClaimCheck>): ClaimCheck => ({
  claim: "the sky is blue",
  status: "unsupported",
  sourceIds: ["1"],
  ...over,
})

describe("markerMarksFor", () => {
  test("skips supported claims", () => {
    const result: VerificationResult = {
      checks: [
        check({ status: "supported", sourceIds: ["1"] }),
        check({ status: "unsupported", sourceIds: ["2"] }),
      ],
      summary: { supported: 1, partial: 0, unsupported: 1, total: 2 },
    }
    const marks = markerMarksFor(result.checks)
    expect(marks.size).toBe(1)
    expect(marks.get("2")).toBeTruthy()
    expect(marks.has("1")).toBe(false)
  })

  test("includes partial claims", () => {
    const result: VerificationResult = {
      checks: [check({ status: "partial", sourceIds: ["3"] })],
      summary: { supported: 0, partial: 1, unsupported: 0, total: 1 },
    }
    const marks = markerMarksFor(result.checks)
    expect(marks.get("3")?.status).toBe("partial")
  })

  test("first claim wins per marker when two share a sourceId", () => {
    const result: VerificationResult = {
      checks: [
        check({ claim: "first", status: "unsupported", sourceIds: ["1"] }),
        check({ claim: "second", status: "partial", sourceIds: ["1"] }),
      ],
      summary: { supported: 0, partial: 1, unsupported: 1, total: 2 },
    }
    const marks = markerMarksFor(result.checks)
    expect(marks.get("1")?.claimText).toBe("first")
  })

  test("empty when all supported", () => {
    const result: VerificationResult = {
      checks: [
        check({ status: "supported", sourceIds: ["1"] }),
        check({ status: "supported", sourceIds: ["2"] }),
      ],
      summary: { supported: 2, partial: 0, unsupported: 0, total: 2 },
    }
    expect(markerMarksFor(result.checks).size).toBe(0)
  })

  test("skips claims with empty sourceIds", () => {
    const result: VerificationResult = {
      checks: [check({ status: "unsupported", sourceIds: [] })],
      summary: { supported: 0, partial: 0, unsupported: 1, total: 1 },
    }
    expect(markerMarksFor(result.checks).size).toBe(0)
  })
})
