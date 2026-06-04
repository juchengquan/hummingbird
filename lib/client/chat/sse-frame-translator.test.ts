/**
 * Tests for the SSE frame translator that lets the chat consumer
 * speak both wire formats — the legacy custom shape and the AI SDK
 * v5 UI message stream. PLAN-useChat-adoption.md Phase B.2.
 */

import { describe, expect, test } from "bun:test"

import { translateFrame } from "./sse-frame-translator"

describe("translateFrame — AI SDK v5 → normalised shape", () => {
  test("text-delta → text/value", () => {
    expect(translateFrame('{"type":"text-delta","id":"t1","delta":"hi"}')).toEqual({
      type: "text",
      value: "hi",
    })
  })

  test("reasoning-delta → reasoning/value", () => {
    expect(
      translateFrame('{"type":"reasoning-delta","id":"r1","delta":"hmm"}'),
    ).toEqual({
      type: "reasoning",
      value: "hmm",
    })
  })

  test("tool-input-available → tool_call with id/name/args", () => {
    const out = translateFrame(
      '{"type":"tool-input-available","toolCallId":"c1","toolName":"webSearch","input":{"query":"x"}}',
    )
    expect(out).toEqual({
      type: "tool_call",
      id: "c1",
      name: "webSearch",
      args: { query: "x" },
    })
  })

  test("tool-output-available → tool_result with parsed summary + results", () => {
    // The backend stringifies the {summary, results} object before
    // putting it in the AI SDK `output` field.
    const inner = JSON.stringify({
      summary: "3 results",
      results: [
        { title: "a", url: "https://a", snippet: "" },
        { title: "b", url: "https://b", snippet: "" },
      ],
    })
    const out = translateFrame(
      `{"type":"tool-output-available","toolCallId":"c1","output":${JSON.stringify(inner)}}`,
    )
    expect(out?.type).toBe("tool_result")
    expect(out?.id).toBe("c1")
    expect(out?.summary).toBe("3 results")
    expect(out?.results).toHaveLength(2)
  })

  test("tool-output-available with errorText surfaces as summary when no summary", () => {
    const inner = JSON.stringify({})
    const out = translateFrame(
      `{"type":"tool-output-available","toolCallId":"c1","output":${JSON.stringify(inner)},"errorText":"rate limit"}`,
    )
    expect(out?.summary).toBe("rate limit")
  })

  test("tool-output-available with non-JSON output → summary undefined", () => {
    const out = translateFrame(
      '{"type":"tool-output-available","toolCallId":"c1","output":"plain"}',
    )
    expect(out?.type).toBe("tool_result")
    expect(out?.id).toBe("c1")
    expect(out?.summary).toBeUndefined()
  })

  test("data-tool-image unwraps the data envelope", () => {
    const out = translateFrame(
      '{"type":"data-tool-image","id":"i1","data":{"id":"i1","mode":"i2i","images":[{"id":"i1-0","url":"https://x"}]}}',
    )
    expect(out?.type).toBe("tool_image")
    expect(out?.id).toBe("i1")
    expect(out?.mode).toBe("i2i")
    expect(out?.images).toHaveLength(1)
  })

  test("data-suggestions unwraps the data envelope", () => {
    const out = translateFrame(
      '{"type":"data-suggestions","data":{"values":["a","b"]}}',
    )
    expect(out).toEqual({ type: "suggestions", values: ["a", "b"] })
  })

  test("data-suggestions filters non-string entries", () => {
    const out = translateFrame(
      '{"type":"data-suggestions","data":{"values":["a",42,null,"b"]}}',
    )
    expect(out?.values).toEqual(["a", "b"])
  })

  test("AI SDK error uses errorText", () => {
    expect(translateFrame('{"type":"error","errorText":"boom"}')).toEqual({
      type: "error",
      message: "boom",
    })
  })

  test("AI SDK error propagates the optional `code` field", () => {
    expect(
      translateFrame(
        '{"type":"error","errorText":"hit the wall","code":"rate_limit"}',
      ),
    ).toEqual({
      type: "error",
      message: "hit the wall",
      code: "rate_limit",
    })
  })

  test("AI SDK error with non-string code is dropped", () => {
    expect(
      translateFrame('{"type":"error","errorText":"boom","code":42}'),
    ).toEqual({
      type: "error",
      message: "boom",
    })
  })
})

describe("translateFrame — lifecycle + edge cases", () => {
  test("AI SDK lifecycle frames are no-ops (null)", () => {
    for (const t of [
      "start",
      "start-step",
      "text-start",
      "text-end",
      "reasoning-start",
      "reasoning-end",
      "finish-step",
      "finish",
    ]) {
      expect(translateFrame(`{"type":"${t}","id":"x"}`)).toBeNull()
    }
  })

  test("invalid JSON → null", () => {
    expect(translateFrame("not json")).toBeNull()
    expect(translateFrame("")).toBeNull()
  })

  test("missing type → null", () => {
    expect(translateFrame('{"foo":"bar"}')).toBeNull()
  })

  test("unknown type → null", () => {
    expect(translateFrame('{"type":"source"}')).toBeNull()
    expect(translateFrame('{"type":"file"}')).toBeNull()
  })

  test("tool-input-available without toolCallId → null", () => {
    expect(
      translateFrame('{"type":"tool-input-available","toolName":"x"}'),
    ).toBeNull()
  })

  test("tool-output-available without toolCallId → null", () => {
    expect(
      translateFrame('{"type":"tool-output-available","output":"x"}'),
    ).toBeNull()
  })

  test("data-tool-image without data → null", () => {
    expect(translateFrame('{"type":"data-tool-image"}')).toBeNull()
  })
})
