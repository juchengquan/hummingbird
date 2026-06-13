import { describe, expect, test } from "bun:test"

import { similarityTargetFor } from "./summarize-similarity"

describe("similarityTargetFor", () => {
  test("file mode → scope + the file text", () => {
    expect(
      similarityTargetFor({ mode: "file", text: "hello world" }, "m"),
    ).toEqual({ scope: "summarize|file|m", text: "hello world" })
  })

  test("project-breakdown with no existingTitles → scope + the goal", () => {
    expect(
      similarityTargetFor({ mode: "project-breakdown", goal: "ship v1" }, "m"),
    ).toEqual({ scope: "summarize|project-breakdown|m", text: "ship v1" })
  })

  test("project-breakdown with an empty existingTitles array → target", () => {
    expect(
      similarityTargetFor(
        { mode: "project-breakdown", goal: "ship v1", existingTitles: [] },
        "m",
      ),
    ).toEqual({ scope: "summarize|project-breakdown|m", text: "ship v1" })
  })

  test("project-breakdown WITH existingTitles → null (no similarity)", () => {
    expect(
      similarityTargetFor(
        { mode: "project-breakdown", goal: "ship v1", existingTitles: ["Set up CI"] },
        "m",
      ),
    ).toBeNull()
  })

  test("conversation mode → null", () => {
    expect(similarityTargetFor({ mode: "conversation" }, "m")).toBeNull()
  })

  test("compress mode → null", () => {
    expect(similarityTargetFor({ mode: "compress" }, "m")).toBeNull()
  })

  test("scope interpolates the model id", () => {
    expect(
      similarityTargetFor({ mode: "file", text: "x" }, "google/gemini-2.5-flash")
        ?.scope,
    ).toBe("summarize|file|google/gemini-2.5-flash")
  })
})
