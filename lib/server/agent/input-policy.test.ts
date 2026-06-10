import { describe, expect, test } from "bun:test"

import {
  ASK_USER_TOOL_NAME,
  RENDER_UI_TOOL_NAME,
  requestKindFor,
} from "./input-policy"

describe("requestKindFor", () => {
  test("renderUI tool → ui-part (regardless of args)", () => {
    expect(requestKindFor(RENDER_UI_TOOL_NAME, undefined)).toBe("ui-part")
    expect(requestKindFor(RENDER_UI_TOOL_NAME, { kind: "choice", props: {} })).toBe(
      "ui-part",
    )
    expect(requestKindFor(RENDER_UI_TOOL_NAME, "garbage")).toBe("ui-part")
  })

  test("askUser tool with options → choice", () => {
    expect(
      requestKindFor(ASK_USER_TOOL_NAME, {
        options: [{ id: "a", label: "A" }],
      }),
    ).toBe("choice")
  })

  test("askUser tool without options → input", () => {
    expect(requestKindFor(ASK_USER_TOOL_NAME, { prompt: "?" })).toBe("input")
    expect(requestKindFor(ASK_USER_TOOL_NAME, undefined)).toBe("input")
  })

  test("askUser with empty options array → input (not choice)", () => {
    expect(requestKindFor(ASK_USER_TOOL_NAME, { options: [] })).toBe("input")
  })

  test("any other tool name → approval (binary gate)", () => {
    expect(requestKindFor("webSearch", {})).toBe("approval")
    expect(requestKindFor("mcp__github__create_issue", {})).toBe("approval")
  })
})
