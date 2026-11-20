import { describe, expect, test } from "bun:test"

import {
  MCP_APP_NS,
  mcpAppToolCallDenial,
  mcpAppToolResult,
  parseMcpAppToolCall,
} from "./mcp-app-bridge"

describe("parseMcpAppToolCall", () => {
  test("accepts a well-formed tool-call", () => {
    expect(
      parseMcpAppToolCall({
        ns: MCP_APP_NS,
        type: "tool-call",
        callId: "c1",
        name: "search",
        args: { q: "x" },
      })
    ).toEqual({ callId: "c1", name: "search", args: { q: "x" } })
  })

  test("args is optional", () => {
    expect(
      parseMcpAppToolCall({
        ns: MCP_APP_NS,
        type: "tool-call",
        callId: "c1",
        name: "ping",
      })
    ).toEqual({ callId: "c1", name: "ping", args: undefined })
  })

  test("rejects a foreign namespace (e.g. the live-artifact bridge)", () => {
    expect(
      parseMcpAppToolCall({
        ns: "live-artifact",
        type: "tool-call",
        callId: "c1",
        name: "x",
      })
    ).toBeNull()
  })

  test("rejects wrong type / missing fields / wrong types", () => {
    const base = { ns: MCP_APP_NS, type: "tool-call", callId: "c1", name: "x" }
    expect(parseMcpAppToolCall({ ...base, type: "tool-result" })).toBeNull()
    expect(parseMcpAppToolCall({ ...base, callId: "" })).toBeNull()
    expect(parseMcpAppToolCall({ ...base, name: "" })).toBeNull()
    expect(parseMcpAppToolCall({ ...base, callId: 5 })).toBeNull()
    expect(parseMcpAppToolCall({ ...base, name: undefined })).toBeNull()
  })

  test("rejects non-objects", () => {
    expect(parseMcpAppToolCall(null)).toBeNull()
    expect(parseMcpAppToolCall("tool-call")).toBeNull()
    expect(parseMcpAppToolCall(42)).toBeNull()
  })
})

describe("mcpAppToolResult", () => {
  test("builds a namespaced response echoing the callId", () => {
    expect(mcpAppToolResult("c1", { ok: true, result: { rows: 3 } })).toEqual({
      ns: MCP_APP_NS,
      type: "tool-result",
      callId: "c1",
      ok: true,
      result: { rows: 3 },
    })
    expect(mcpAppToolResult("c2", { ok: false, error: "nope" })).toEqual({
      ns: MCP_APP_NS,
      type: "tool-result",
      callId: "c2",
      ok: false,
      error: "nope",
    })
  })
})

describe("mcpAppToolCallDenial", () => {
  test("allows an enabled server without approval policy", () => {
    expect(mcpAppToolCallDenial({ enabled: true })).toBeNull()
    expect(mcpAppToolCallDenial({ enabled: true, requiresApproval: false })).toBeNull()
  })

  test("refuses missing / deleted servers", () => {
    expect(mcpAppToolCallDenial(undefined)).toMatch(/not available/)
    expect(mcpAppToolCallDenial({ enabled: true, deletedAt: new Date() })).toMatch(
      /not available/
    )
  })

  test("refuses a disabled server", () => {
    expect(mcpAppToolCallDenial({ enabled: false })).toMatch(/disabled/)
  })

  test("refuses an approval-gated server (no approval path for panels)", () => {
    expect(mcpAppToolCallDenial({ enabled: true, requiresApproval: true })).toMatch(
      /requires approval/
    )
  })
})
