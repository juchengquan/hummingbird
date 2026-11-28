/**
 * Tests for the data-part + tool-output helpers chat on runs shares
 * (`lib/client/runs/reducer.ts`): `translateDataPart` re-shapes a
 * `data-*` part into the internal `NormalisedFrame`, `parseToolOutput`
 * reads a tool result's `{summary, results}`.
 */

import { describe, expect, test } from "bun:test"

import { parseToolOutput, translateDataPart } from "./sse-frame-translator"

describe("translateDataPart", () => {
  test("data-tool-image unwraps the data envelope", () => {
    const out = translateDataPart("data-tool-image", {
      id: "i1",
      mode: "i2i",
      images: [{ id: "i1-0", url: "https://x" }],
    })
    expect(out?.type).toBe("tool_image")
    expect(out?.id).toBe("i1")
    expect(out?.mode).toBe("i2i")
    expect(out?.images).toHaveLength(1)
  })

  test("data-tool-image without data → null", () => {
    expect(translateDataPart("data-tool-image", undefined)).toBeNull()
  })

  test("data-code-result → code_result", () => {
    const out = translateDataPart("data-code-result", {
      id: "c1",
      stdout: "4\n",
      stderr: "",
      results: [{ type: "text", value: "4\n" }],
    })
    expect(out).toEqual({
      type: "code_result",
      id: "c1",
      stdout: "4\n",
      stderr: "",
      codeCells: [{ type: "text", value: "4\n" }],
    })
  })

  test("malformed data-code-result → null", () => {
    expect(translateDataPart("data-code-result", undefined)).toBeNull()
  })

  test("data-suggestions unwraps the data envelope, dropping non-strings", () => {
    expect(translateDataPart("data-suggestions", { values: ["a", "b"] })).toEqual({
      type: "suggestions",
      values: ["a", "b"],
    })
    expect(translateDataPart("data-suggestions", { values: ["a", 42, null, "b"] })?.values).toEqual([
      "a",
      "b",
    ])
  })

  test("data-routed-model → routed_model", () => {
    expect(translateDataPart("data-routed-model", { model: "m" })).toEqual({
      type: "routed_model",
      value: "m",
    })
  })

  test("data-verification → verification frame with recomputed summary", () => {
    const out = translateDataPart("data-verification", {
      checks: [
        { claim: "X [1].", status: "supported", sourceIds: ["1"] },
        { claim: "Y [2].", status: "unsupported", sourceIds: [] },
      ],
    })
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
    expect(translateDataPart("data-verification", { checks: [] })).toBeNull()
    expect(translateDataPart("data-verification", {})).toBeNull()
  })

  test("data-tool-file — translates a tool-file part", () => {
    const files = [
      { id: "call-0-0", name: "report.csv", sizeBytes: 12, mimeType: "text/csv", url: "data:..." },
    ]
    expect(translateDataPart("data-tool-file", { id: "call-0", files })).toEqual({
      type: "tool_file",
      id: "call-0",
      files,
    })
    expect(translateDataPart("data-tool-file", undefined)).toBeNull()
  })

  test("data-ui — emits ui_part with id/kind/props", () => {
    const out = translateDataPart("data-ui", {
      id: "call-1",
      kind: "info-table",
      props: { rows: [{ k: "v" }] },
    })
    expect(out?.type).toBe("ui_part")
    expect(out?.id).toBe("call-1")
    expect(out?.kind).toBe("info-table")
    expect((out?.props as { rows: unknown[] }).rows).toEqual([{ k: "v" }])
  })

  test("data-ui without data, or without id/kind → null", () => {
    expect(translateDataPart("data-ui", undefined)).toBeNull()
    expect(translateDataPart("data-ui", { props: {} })).toBeNull()
    expect(translateDataPart("data-ui", { id: 1 })).toBeNull()
  })

  test("data-mcp-app — emits mcp_app with id/serverId/html", () => {
    const out = translateDataPart("data-mcp-app", {
      id: "call-9",
      serverId: "srv1",
      html: "<h1>hi</h1>",
    })
    expect(out?.type).toBe("mcp_app")
    expect(out?.id).toBe("call-9")
    expect(out?.serverId).toBe("srv1")
    expect(out?.html).toBe("<h1>hi</h1>")
    // The phase 3 fields are optional.
    expect(out?.resourceUri).toBeUndefined()
    expect(out?.truncated).toBeUndefined()
  })

  test("data-mcp-app missing html/serverId → null", () => {
    expect(translateDataPart("data-mcp-app", { id: "x" })).toBeNull()
    expect(translateDataPart("data-mcp-app", undefined)).toBeNull()
  })

  test("data-mcp-app — phase 3 fields (resourceUri + truncated) round-trip", () => {
    const out = translateDataPart("data-mcp-app", {
      id: "call-9",
      serverId: "srv1",
      html: "<!-- truncated -->",
      resourceUri: "ui://widget/main.html",
      truncated: true,
    })
    expect(out?.type).toBe("mcp_app")
    expect(out?.resourceUri).toBe("ui://widget/main.html")
    expect(out?.truncated).toBe(true)
  })

  test("data-mcp-app — truncated:false is normalised to undefined (only `true` counts)", () => {
    const out = translateDataPart("data-mcp-app", {
      id: "call-9",
      serverId: "srv1",
      html: "<h1>hi</h1>",
      truncated: false,
    })
    expect(out?.truncated).toBeUndefined()
  })

  test("unknown types and malformed payloads are null", () => {
    expect(translateDataPart("data-nope", {})).toBeNull()
    expect(translateDataPart("data-suggestions", undefined)).toBeNull()
  })
})

describe("parseToolOutput", () => {
  test("reads {summary, results} and falls back to errorText", () => {
    expect(
      parseToolOutput(JSON.stringify({ summary: "2 results", results: [{ title: "t" }, 3] })),
    ).toEqual({ summary: "2 results", results: [{ title: "t" }] })
    expect(parseToolOutput(JSON.stringify({}), "rate limit")).toEqual({
      summary: "rate limit",
      results: undefined,
    })
    expect(parseToolOutput("not json", "boom")).toEqual({ summary: "boom", results: undefined })
    expect(parseToolOutput("plain")).toEqual({ summary: undefined, results: undefined })
    expect(parseToolOutput(undefined)).toEqual({ summary: undefined, results: undefined })
  })
})
