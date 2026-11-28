import { describe, expect, it } from "bun:test"

import { diffLines, prettyForDiff } from "./diff"

describe("diffLines", () => {
  it("returns one equal segment for identical text", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([{ op: "equal", text: "a\nb" }])
  })
  it("detects an inserted line", () => {
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([
      { op: "equal", text: "a" },
      { op: "insert", text: "b" },
      { op: "equal", text: "c" },
    ])
  })
  it("detects a deleted line", () => {
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([
      { op: "equal", text: "a" },
      { op: "delete", text: "b" },
      { op: "equal", text: "c" },
    ])
  })
  it("represents a replacement as delete + insert", () => {
    expect(diffLines("a\nx\nc", "a\ny\nc")).toEqual([
      { op: "equal", text: "a" },
      { op: "delete", text: "x" },
      { op: "insert", text: "y" },
      { op: "equal", text: "c" },
    ])
  })
  it("handles an empty old side (all insert)", () => {
    expect(diffLines("", "a")).toEqual([
      { op: "delete", text: "" },
      { op: "insert", text: "a" },
    ])
  })
})

describe("prettyForDiff", () => {
  it("pretty-prints json/table content", () => {
    expect(prettyForDiff('{"a":1}', "json")).toBe('{\n  "a": 1\n}')
    expect(prettyForDiff('{"a":1}', "table")).toBe('{\n  "a": 1\n}')
  })
  it("returns non-json kinds unchanged", () => {
    expect(prettyForDiff("# hi", "markdown")).toBe("# hi")
  })
  it("returns the raw string when json is invalid (no throw)", () => {
    expect(prettyForDiff("{not json", "json")).toBe("{not json")
  })
})
