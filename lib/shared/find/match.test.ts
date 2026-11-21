import { describe, expect, it } from "bun:test"

import { findMatchOffsets, findSegmentMatches, foldCase, wrapIndex } from "./match"

describe("foldCase", () => {
  it("lower-cases ASCII", () => {
    expect(foldCase("Hello WORLD")).toBe("hello world")
  })
  it("keeps the string length so offsets stay aligned", () => {
    // "İ".toLowerCase() is two UTF-16 units ("i̇"); folding must not shift
    // the offsets of everything after it.
    const s = "İstanbul Stan"
    expect(foldCase(s).length).toBe(s.length)
    expect(foldCase(s).slice(9)).toBe("stan")
  })
  it("leaves astral characters intact", () => {
    expect(foldCase("A😀B")).toBe("a😀b")
  })
})

describe("findMatchOffsets", () => {
  it("finds all case-insensitive occurrences", () => {
    expect(findMatchOffsets("Foo foo FOO", "foo")).toEqual([0, 4, 8])
  })
  it("is non-overlapping", () => {
    expect(findMatchOffsets("aaaa", "aa")).toEqual([0, 2])
  })
  it("matches at the edges", () => {
    expect(findMatchOffsets("xhellox", "x")).toEqual([0, 6])
  })
  it("returns [] for no match", () => {
    expect(findMatchOffsets("abc", "z")).toEqual([])
  })
  it("returns [] for an empty or whitespace-only needle", () => {
    expect(findMatchOffsets("abc", "")).toEqual([])
    expect(findMatchOffsets("abc", "   ")).toEqual([])
  })
  it("returns offsets into the original string after a length-changing char", () => {
    const hay = "İstanbul Stan"
    expect(findMatchOffsets(hay, "stan")).toEqual([1, 9])
    expect(hay.slice(9, 13)).toBe("Stan")
  })
})

describe("findSegmentMatches", () => {
  it("maps a match inside one segment", () => {
    expect(findSegmentMatches([{ text: "say hello", breakBefore: false }], "hello")).toEqual([
      { start: { segment: 0, offset: 4 }, end: { segment: 0, offset: 9 } },
    ])
  })
  it("spans adjacent inline segments (e.g. `foo **bar**`)", () => {
    const segs = [
      { text: "foo ba", breakBefore: false },
      { text: "r baz", breakBefore: false },
    ]
    expect(findSegmentMatches(segs, "bar")).toEqual([
      { start: { segment: 0, offset: 4 }, end: { segment: 1, offset: 1 } },
    ])
  })
  it("ends a match exactly at a segment boundary in that segment", () => {
    const segs = [
      { text: "abc", breakBefore: false },
      { text: "def", breakBefore: false },
    ]
    expect(findSegmentMatches(segs, "bc")).toEqual([
      { start: { segment: 0, offset: 1 }, end: { segment: 0, offset: 3 } },
    ])
  })
  it("never matches across a block break", () => {
    const segs = [
      { text: "end of foo", breakBefore: false },
      { text: "bar starts", breakBefore: true },
    ]
    expect(findSegmentMatches(segs, "foobar")).toEqual([])
    expect(findSegmentMatches(segs, "foo bar")).toEqual([])
  })
  it("finds matches in every segment in document order", () => {
    const segs = [
      { text: "Cat", breakBefore: false },
      { text: "dog", breakBefore: true },
      { text: "cat", breakBefore: true },
    ]
    expect(findSegmentMatches(segs, "cat").map((m) => m.start.segment)).toEqual([0, 2])
  })
  it("returns [] for a blank query or no segments", () => {
    expect(findSegmentMatches([{ text: "abc", breakBefore: false }], " ")).toEqual([])
    expect(findSegmentMatches([], "a")).toEqual([])
  })
})

describe("wrapIndex", () => {
  it("steps forward and wraps at the end", () => {
    expect(wrapIndex(0, 3, 1)).toBe(1)
    expect(wrapIndex(2, 3, 1)).toBe(0)
  })
  it("steps back and wraps at the start", () => {
    expect(wrapIndex(0, 3, -1)).toBe(2)
    expect(wrapIndex(1, 3, -1)).toBe(0)
  })
  it("returns 0 when total is 0", () => {
    expect(wrapIndex(0, 0, 1)).toBe(0)
  })
})
