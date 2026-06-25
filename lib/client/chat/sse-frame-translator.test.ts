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

  test("data-code-result → code_result", () => {
    const out = translateFrame(
      '{"type":"data-code-result","data":{"id":"c1","stdout":"4\\n","stderr":"","results":[{"type":"text","value":"4\\n"}]}}',
    )
    expect(out).toEqual({
      type: "code_result",
      id: "c1",
      stdout: "4\n",
      stderr: "",
      codeCells: [{ type: "text", value: "4\n" }],
    })
  })

  test("malformed data-code-result → null", () => {
    expect(translateFrame('{"type":"data-code-result"}')).toBeNull()
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

  test("data-verification → verification frame with recomputed summary", () => {
    const out = translateFrame(
      '{"type":"data-verification","data":{"checks":[{"claim":"X [1].","status":"supported","sourceIds":["1"]},{"claim":"Y [2].","status":"unsupported","sourceIds":[]}]}}',
    )
    expect(out?.type).toBe("verification")
    expect(out?.verification?.checks).toHaveLength(2)
    expect(out?.verification?.summary).toEqual({
      supported: 1,
      partial: 0,
      unsupported: 1,
      total: 2,
    })
  })

  test("data-verification with no valid checks → null", () => {
    expect(
      translateFrame('{"type":"data-verification","data":{"checks":[]}}'),
    ).toBeNull()
    expect(
      translateFrame('{"type":"data-verification","data":{}}'),
    ).toBeNull()
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

  test("data-tool-file — translates a tool-file frame", () => {
    const out = translateFrame(
      JSON.stringify({
        type: "data-tool-file",
        data: {
          id: "call-0",
          files: [
            { id: "call-0-0", name: "report.csv", sizeBytes: 12, mimeType: "text/csv", url: "data:..." },
          ],
        },
      }),
    )
    expect(out).toEqual({
      type: "tool_file",
      id: "call-0",
      files: [
        { id: "call-0-0", name: "report.csv", sizeBytes: 12, mimeType: "text/csv", url: "data:..." },
      ],
    })
  })

  test("data-tool-file without data → null", () => {
    expect(translateFrame(JSON.stringify({ type: "data-tool-file" }))).toBeNull()
  })

  test("data-ui — emits ui_part with id/kind/props", () => {
    const out = translateFrame(
      JSON.stringify({
        type: "data-ui",
        id: "call-1",
        data: {
          id: "call-1",
          kind: "info-table",
          props: { rows: [{ k: "v" }] },
        },
      }),
    )
    expect(out?.type).toBe("ui_part")
    expect(out?.id).toBe("call-1")
    expect(out?.kind).toBe("info-table")
    expect((out?.props as { rows: unknown[] }).rows).toEqual([{ k: "v" }])
  })

  test("data-ui without data → null", () => {
    expect(translateFrame('{"type":"data-ui"}')).toBeNull()
  })

  test("data-ui without id/kind on data → null", () => {
    expect(
      translateFrame('{"type":"data-ui","data":{"props":{}}}'),
    ).toBeNull()
  })

  test("data-mcp-app — emits mcp_app with id/serverId/html", () => {
    const out = translateFrame(
      JSON.stringify({
        type: "data-mcp-app",
        id: "call-9",
        data: { id: "call-9", serverId: "srv1", html: "<h1>hi</h1>" },
      }),
    )
    expect(out?.type).toBe("mcp_app")
    expect(out?.id).toBe("call-9")
    expect(out?.serverId).toBe("srv1")
    expect(out?.html).toBe("<h1>hi</h1>")
  })

  test("data-mcp-app missing html/serverId → null", () => {
    expect(
      translateFrame('{"type":"data-mcp-app","data":{"id":"x"}}'),
    ).toBeNull()
    expect(translateFrame('{"type":"data-mcp-app"}')).toBeNull()
  })

  test("data-mcp-app — phase 3 fields (resourceUri + truncated) round-trip", () => {
    const out = translateFrame(
      JSON.stringify({
        type: "data-mcp-app",
        id: "call-9",
        data: {
          id: "call-9",
          serverId: "srv1",
          html: "<!-- truncated -->",
          resourceUri: "ui://widget/main.html",
          truncated: true,
        },
      }),
    )
    expect(out?.type).toBe("mcp_app")
    expect(out?.resourceUri).toBe("ui://widget/main.html")
    expect(out?.truncated).toBe(true)
  })

  test("data-mcp-app — phase 3 fields are optional (pre-phase-3 emit unchanged)", () => {
    // A server that hasn't shipped phase 3 omits the new fields; the
    // translator must still accept the frame and just leave the new
    // fields undefined.
    const out = translateFrame(
      JSON.stringify({
        type: "data-mcp-app",
        id: "call-9",
        data: { id: "call-9", serverId: "srv1", html: "<h1>hi</h1>" },
      }),
    )
    expect(out?.type).toBe("mcp_app")
    expect(out?.resourceUri).toBeUndefined()
    expect(out?.truncated).toBeUndefined()
  })

  test("data-mcp-app — truncated:false on the wire is normalised to undefined (only `true` counts)", () => {
    // Defensive — don't surface an explicit `false` as if it were a
    // distinct state; the absence of the flag means "not truncated".
    const out = translateFrame(
      JSON.stringify({
        type: "data-mcp-app",
        id: "call-9",
        data: {
          id: "call-9",
          serverId: "srv1",
          html: "<h1>hi</h1>",
          truncated: false,
        },
      }),
    )
    expect(out?.truncated).toBeUndefined()
  })
})
