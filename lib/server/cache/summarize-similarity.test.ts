import { describe, expect, test } from "bun:test"

import { similarityTargetFor } from "./summarize-similarity"

describe("similarityTargetFor", () => {
  test("file mode → scope + the file text", () => {
    expect(
      similarityTargetFor({ mode: "file", text: "hello world" }, "m", "user:a"),
    ).toEqual({ scope: "summarize|user:a|file|m", text: "hello world" })
  })

  test("project-breakdown with no existingTitles → scope + the goal", () => {
    expect(
      similarityTargetFor({ mode: "project-breakdown", goal: "ship v1" }, "m", "user:a"),
    ).toEqual({ scope: "summarize|user:a|project-breakdown|m", text: "ship v1" })
  })

  test("project-breakdown with an empty existingTitles array → target", () => {
    expect(
      similarityTargetFor(
        { mode: "project-breakdown", goal: "ship v1", existingTitles: [] },
        "m",
        "user:a",
      ),
    ).toEqual({ scope: "summarize|user:a|project-breakdown|m", text: "ship v1" })
  })

  test("project-breakdown WITH existingTitles → null (no similarity)", () => {
    expect(
      similarityTargetFor(
        { mode: "project-breakdown", goal: "ship v1", existingTitles: ["Set up CI"] },
        "m",
        "user:a",
      ),
    ).toBeNull()
  })

  test("conversation mode → null", () => {
    expect(similarityTargetFor({ mode: "conversation" }, "m", "user:a")).toBeNull()
  })

  test("compress mode → null", () => {
    expect(similarityTargetFor({ mode: "compress" }, "m", "user:a")).toBeNull()
  })

  test("scope interpolates the model id", () => {
    expect(
      similarityTargetFor(
        { mode: "file", text: "x" },
        "google/gemini-2.5-flash",
        "user:a",
      )?.scope,
    ).toBe("summarize|user:a|file|google/gemini-2.5-flash")
  })

  test("scope is partitioned by caller (no cross-user near-match)", () => {
    const a = similarityTargetFor({ mode: "file", text: "x" }, "m", "user:a")
    const b = similarityTargetFor({ mode: "file", text: "x" }, "m", "user:b")
    const anon = similarityTargetFor({ mode: "file", text: "x" }, "m", "anon:1")
    expect(a?.scope).not.toBe(b?.scope)
    expect(a?.scope).not.toBe(anon?.scope)
    const pa = similarityTargetFor({ mode: "project-breakdown", goal: "g" }, "m", "user:a")
    const pb = similarityTargetFor({ mode: "project-breakdown", goal: "g" }, "m", "user:b")
    expect(pa?.scope).not.toBe(pb?.scope)
  })
})
