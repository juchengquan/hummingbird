import { describe, expect, test } from "bun:test"

import type { RetrievedSource } from "@/shared/verify"
import { buildVerifyPrompt, verifyAnswer } from "./verify-answer"

const SOURCES: RetrievedSource[] = [
  {
    id: "1",
    title: "Boiling point of water",
    url: "https://example.com/boil",
    snippet: "At sea level, water boils at 100 degrees Celsius.",
  },
  {
    id: "2",
    title: "Mars facts",
    snippet: "Mars has two moons, Phobos and Deimos.",
  },
]

const ANSWER =
  "Water boils at 100°C at sea level [1]. Mars has three moons [2]. The weather is nice today."

describe("verifyAnswer", () => {
  test("no cited claims → no model call, empty result", async () => {
    let called = false
    const result = await verifyAnswer("A plain uncited answer.", SOURCES, {
      runVerifier: async () => {
        called = true
        return []
      },
    })
    expect(called).toBe(false)
    expect(result).toEqual({
      checks: [],
      summary: { supported: 0, partial: 0, unsupported: 0, total: 0 },
    })
  })

  test("no sources → no model call (cost guard)", async () => {
    let called = false
    const result = await verifyAnswer(ANSWER, [], {
      runVerifier: async () => {
        called = true
        return []
      },
    })
    expect(called).toBe(false)
    expect(result.checks).toEqual([])
  })

  test("maps verifier verdicts onto claims + summarizes", async () => {
    const result = await verifyAnswer(ANSWER, SOURCES, {
      runVerifier: async () => [
        { claim: 1, status: "supported", sourceIds: ["1"] },
        { claim: 2, status: "unsupported", sourceIds: [] },
      ],
    })
    expect(result.checks).toEqual([
      {
        claim: "Water boils at 100°C at sea level [1].",
        status: "supported",
        sourceIds: ["1"],
      },
      { claim: "Mars has three moons [2].", status: "unsupported", sourceIds: [] },
    ])
    expect(result.summary).toEqual({
      supported: 1,
      partial: 0,
      unsupported: 1,
      total: 2,
    })
  })

  test("verifier throwing → empty result (non-blocking)", async () => {
    const result = await verifyAnswer(ANSWER, SOURCES, {
      runVerifier: async () => {
        throw new Error("provider down")
      },
    })
    expect(result).toEqual({
      checks: [],
      summary: { supported: 0, partial: 0, unsupported: 0, total: 0 },
    })
  })

  test("the prompt receives the cited claims, not uncited prose", async () => {
    let seenPrompt = ""
    await verifyAnswer(ANSWER, SOURCES, {
      runVerifier: async (prompt) => {
        seenPrompt = prompt
        return []
      },
    })
    expect(seenPrompt).toContain("Water boils at 100°C at sea level [1].")
    expect(seenPrompt).toContain("Mars has three moons [2].")
    expect(seenPrompt).not.toContain("The weather is nice today")
  })
})

describe("buildVerifyPrompt", () => {
  test("renders numbered sources and claims with strict-JSON instruction", () => {
    const prompt = buildVerifyPrompt(
      [{ text: "Claim one [1].", citedIndices: [1] }],
      SOURCES
    )
    expect(prompt).toContain("[1] Boiling point of water")
    expect(prompt).toContain("https://example.com/boil")
    expect(prompt).toContain("1. Claim one [1].  (cites: [1])")
    expect(prompt).toContain('"checks"')
  })
})
