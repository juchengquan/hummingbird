/** The answer cards' model: the task strip's question, and the respond
 *  bodies it sends — pinned to what the strip sent before the cards were
 *  shared with chat. */

import { describe, expect, test } from "bun:test"

import { respondBodyForUiAnswer } from "@/shared/generative-ui/schemas"

import {
  canSubmitSelection,
  canSubmitValue,
  describeCardAnswer,
  formatToolArgs,
  isAnswerReason,
  questionFromPendingInput,
  respondBodyForCardAnswer,
  toggleSelection,
} from "./answer-cards"

describe("questionFromPendingInput", () => {
  test("kind defaults to approval; fields carried over", () => {
    expect(
      questionFromPendingInput({ requestId: "r1", tool: "send", args: { to: "bob" } } as never),
    ).toMatchObject({ id: "r1", reason: "approval", tool: "send", args: { to: "bob" } })
    expect(
      questionFromPendingInput({
        requestId: "r2",
        kind: "choice",
        prompt: "Which?",
        options: [{ id: "a", label: "A" }],
        multi: true,
      }),
    ).toMatchObject({ id: "r2", reason: "choice", prompt: "Which?", multi: true })
  })
})

describe("respondBodyForCardAnswer (the task strip's respond body)", () => {
  test("approval / choice / input: { requestId, ...answer }, as before", () => {
    expect(respondBodyForCardAnswer("r", { approved: true })).toEqual({ requestId: "r", approved: true })
    expect(respondBodyForCardAnswer("r", { approved: false })).toEqual({ requestId: "r", approved: false })
    expect(respondBodyForCardAnswer("r", { selection: ["a", "b"] })).toEqual({
      requestId: "r",
      selection: ["a", "b"],
    })
    expect(respondBodyForCardAnswer("r", { value: " hi " })).toEqual({ requestId: "r", value: " hi " })
  })

  test("ui-part: respondBodyForUiAnswer, unchanged", () => {
    const part = { kind: "confirm" as const, props: { prompt: "Sure?" } }
    const uiAnswer = { kind: "confirm" as const, confirmed: true }
    expect(respondBodyForCardAnswer("r", { uiAnswer, part })).toEqual(
      respondBodyForUiAnswer("r", part, uiAnswer),
    )
    expect(respondBodyForCardAnswer("r", { uiAnswer, part })).toEqual({
      requestId: "r",
      uiAnswer,
      value: "Yes",
    })
  })
})

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
