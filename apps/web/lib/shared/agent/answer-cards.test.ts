/** The answer cards' model: the card form helpers and the answer
 *  descriptions. */

import { describe, expect, test } from "bun:test"

import {
  canSubmitSelection,
  canSubmitValue,
  describeCardAnswer,
  formatToolArgs,
  isAnswerReason,
  toggleSelection,
} from "./answer-cards"

describe("card form helpers", () => {
  test("toggleSelection: single replaces, multi toggles", () => {
    expect(toggleSelection(["a"], "b", false)).toEqual(["b"])
    expect(toggleSelection(["a"], "a", false)).toEqual(["a"])
    expect(toggleSelection(["a"], "b", true)).toEqual(["a", "b"])
    expect(toggleSelection(["a", "b"], "a", true)).toEqual(["b"])
  })

  test("submit gates", () => {
    expect(canSubmitSelection([])).toBe(false)
    expect(canSubmitSelection(["a"])).toBe(true)
    expect(canSubmitValue("   ")).toBe(false)
    expect(canSubmitValue(" x ")).toBe(true)
  })

  test("formatToolArgs", () => {
    expect(formatToolArgs(undefined)).toBe("")
    expect(formatToolArgs(null)).toBe("")
    expect(formatToolArgs({ a: 1 })).toBe('{\n  "a": 1\n}')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(formatToolArgs(cyclic)).toBe("[object Object]")
  })

  test("isAnswerReason", () => {
    expect(isAnswerReason("ui-part")).toBe(true)
    expect(isAnswerReason("teleport")).toBe(false)
  })

  test("describeCardAnswer", () => {
    const q = { id: "q", reason: "choice" as const, options: [{ id: "a", label: "Apple" }] }
    expect(describeCardAnswer(q, { selection: ["a", "zz"] })).toBe("Apple, zz")
    expect(describeCardAnswer(q, { value: "typed" })).toBe("typed")
    expect(describeCardAnswer(q, { approved: true })).toBe("Approved")
  })
})
