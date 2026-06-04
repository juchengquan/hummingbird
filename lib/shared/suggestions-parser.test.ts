/**
 * Tests for the shared suggestion JSON parser. Mirrors the contracts
 * tested separately in `lib/server/chat/suggestions.test.ts` and
 * `services/agent-ts/tests/chat.test.ts` before consolidation — both
 * call this module now and re-export it.
 */

import { describe, expect, test } from "bun:test"

import {
  SUGGESTION_MAX_CHARS,
  SUGGESTION_MAX_COUNT,
  parseSuggestionsJson,
} from "./suggestions-parser"

describe("parseSuggestionsJson", () => {
  test("happy path returns up to 3 strings", () => {
    expect(parseSuggestionsJson('["one","two","three"]')).toEqual([
      "one",
      "two",
      "three",
    ])
  })

  test("strips ```json fence + trailing ```", () => {
    expect(parseSuggestionsJson('```json\n["a","b"]\n```')).toEqual(["a", "b"])
  })

  test("strips a bare ``` fence (no language)", () => {
    expect(parseSuggestionsJson('```\n["a"]\n```')).toEqual(["a"])
  })

  test("caps at SUGGESTION_MAX_COUNT entries", () => {
    expect(SUGGESTION_MAX_COUNT).toBe(3)
    expect(parseSuggestionsJson('["a","b","c","d","e"]')).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  test("filters empty / whitespace-only strings", () => {
    expect(parseSuggestionsJson('["ok","  ","","fine"]')).toEqual([
      "ok",
      "fine",
    ])
  })

  test("filters strings longer than SUGGESTION_MAX_CHARS", () => {
    expect(SUGGESTION_MAX_CHARS).toBe(120)
    const raw = JSON.stringify(["ok", "x".repeat(121), "fine"])
    expect(parseSuggestionsJson(raw)).toEqual(["ok", "fine"])
  })

  test("filters non-string entries", () => {
    const raw = JSON.stringify(["a", 42, null, { x: 1 }, "b"])
    expect(parseSuggestionsJson(raw)).toEqual(["a", "b"])
  })

  test("invalid JSON yields empty (decoration must never crash)", () => {
    expect(parseSuggestionsJson("not json")).toEqual([])
    expect(parseSuggestionsJson("")).toEqual([])
    expect(parseSuggestionsJson('{"not":"an array"}')).toEqual([])
  })

  test("trims surrounding whitespace before fence-stripping", () => {
    expect(parseSuggestionsJson('   \n```json\n["a"]\n```   ')).toEqual(["a"])
  })
})
