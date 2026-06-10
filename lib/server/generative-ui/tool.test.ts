import { describe, expect, test } from "bun:test"

import { RENDER_UI_TOOL_NAME, buildRenderUITool } from "./tool"

describe("buildRenderUITool — RENDER_UI_TOOL_NAME constant", () => {
  test("matches the model-facing tool name", () => {
    expect(RENDER_UI_TOOL_NAME).toBe("renderUI")
  })
})

describe("buildRenderUITool — execute (validation gate)", () => {
  test("returns the validated pair on a well-formed info-table", async () => {
    const t = buildRenderUITool()
    // The AI SDK's `tool()` typings hide `execute` behind a runtime
    // accessor; we call it directly the same way the SDK would at
    // tool-invocation time.
    const result = await (
      t as unknown as {
        execute: (input: { kind: string; props: unknown }) => Promise<{
          kind: string
          props: unknown
          error?: string
        }>
      }
    ).execute({
      kind: "info-table",
      props: { rows: [{ k: "v" }] },
    })
    expect(result.error).toBeUndefined()
    expect(result.kind).toBe("info-table")
  })

  test("returns an error string on malformed props (model can self-correct)", async () => {
    const t = buildRenderUITool()
    const result = await (
      t as unknown as {
        execute: (input: { kind: string; props: unknown }) => Promise<{
          kind: string
          props: unknown
          error?: string
        }>
      }
    ).execute({
      kind: "info-table",
      props: { rows: "not-an-array" },
    })
    expect(result.error).toBeDefined()
    expect(result.error).toContain("info-table")
  })

  test("rejects an unknown kind (allow-list is the security boundary)", async () => {
    const t = buildRenderUITool()
    // The SDK's `inputSchema` would normally reject this at parse
    // time, but `execute`'s defensive re-check still covers it for
    // any path that bypasses the SDK validation (e.g. a custom
    // tool-invocation harness).
    const result = await (
      t as unknown as {
        execute: (input: { kind: string; props: unknown }) => Promise<{
          kind: string
          props: unknown
          error?: string
        }>
      }
    ).execute({
      kind: "not-a-kind",
      props: {},
    })
    expect(result.error).toBeDefined()
  })
})
