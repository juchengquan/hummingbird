/**
 * Tests for the follow-up suggestion JSON parser. The actual
 * `generateSuggestions` function calls the AI gateway; we test only
 * the pure parsing layer here (the network call is exercised by the
 * agent-py and agent-ts twins which have their own integration tests).
 */

import { describe, expect, test } from "bun:test"

import { parseSuggestionsJson } from "./suggestions"

describe("parseSuggestionsJson", () => {
  test("happy path returns up to 3 strings", () => {
    expect(parseSuggestionsJson('["one", "two", "three"]')).toEqual([
      "one",
      "two",
      "three",
    ])
  })

  test("strips ```json fence + trailing ```", () => {
    expect(parseSuggestionsJson('```json\n["a", "b"]\n```')).toEqual(["a", "b"])
  })

  test("strips a bare ``` fence (no language) too", () => {
    expect(parseSuggestionsJson('```\n["a"]\n```')).toEqual(["a"])
  })

  test("caps at 3 entries (extras dropped silently)", () => {
    expect(parseSuggestionsJson('["a", "b", "c", "d", "e"]')).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  test("filters empty / whitespace-only strings", () => {
    expect(parseSuggestionsJson('["ok", "  ", "", "fine"]')).toEqual([
      "ok",
      "fine",
    ])
  })

  test("filters strings longer than 120 chars", () => {
    const raw = JSON.stringify(["ok", "x".repeat(121), "fine"])
    expect(parseSuggestionsJson(raw)).toEqual(["ok", "fine"])
  })

  test("filters non-string entries", () => {
    const raw = JSON.stringify(["a", 42, null, { x: 1 }, "b"])
    expect(parseSuggestionsJson(raw)).toEqual(["a", "b"])
  })

  test("invalid JSON yields empty array (decoration shouldn't crash)", () => {
    expect(parseSuggestionsJson("not json")).toEqual([])
    expect(parseSuggestionsJson("")).toEqual([])
    expect(parseSuggestionsJson('{"not": "an array"}')).toEqual([])
  })

  test("trims surrounding whitespace before fence-stripping", () => {
    expect(parseSuggestionsJson('   \n```json\n["a"]\n```   ')).toEqual(["a"])
  })
})
