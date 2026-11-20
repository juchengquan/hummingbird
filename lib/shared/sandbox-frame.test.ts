import { describe, expect, test } from "bun:test"

import {
  isShellReadyMessage,
  parseRenderMessage,
  renderMessage,
  SANDBOX_FRAME_NS,
  SANDBOX_FRAME_PATH,
  shellReadyMessage,
} from "./sandbox-frame"

describe("sandbox frame protocol", () => {
  test("path and namespace are the documented constants", () => {
    expect(SANDBOX_FRAME_PATH).toBe("/sandbox/frame")
    expect(SANDBOX_FRAME_NS).toBe("sandbox-frame")
  })

  test("builders and validators round-trip", () => {
    expect(isShellReadyMessage(shellReadyMessage())).toBe(true)
    expect(parseRenderMessage(renderMessage("<p>hi</p>"))).toBe("<p>hi</p>")
    // Empty HTML is still a valid (blank) render.
    expect(parseRenderMessage(renderMessage(""))).toBe("")
  })

  test("survive structured clone (what postMessage does)", () => {
    expect(isShellReadyMessage(structuredClone(shellReadyMessage()))).toBe(true)
    expect(parseRenderMessage(structuredClone(renderMessage("<b>x</b>")))).toBe("<b>x</b>")
  })

  test("isShellReadyMessage rejects everything else", () => {
    for (const bad of [
      null,
      undefined,
      "shell-ready",
      42,
      [],
      {},
      { ns: SANDBOX_FRAME_NS },
      { ns: SANDBOX_FRAME_NS, type: "render", html: "" },
      { ns: "live-artifact", type: "shell-ready" },
      { ns: "live-artifact", type: "ready" },
      { ns: "mcp-app", type: "shell-ready" },
    ]) {
      expect(isShellReadyMessage(bad)).toBe(false)
    }
  })

  test("parseRenderMessage rejects everything else", () => {
    for (const bad of [
      null,
      undefined,
      "<p>hi</p>",
      { ns: SANDBOX_FRAME_NS, type: "render" },
      { ns: SANDBOX_FRAME_NS, type: "render", html: 1 },
      { ns: SANDBOX_FRAME_NS, type: "render", html: { toString: () => "x" } },
      { ns: SANDBOX_FRAME_NS, type: "shell-ready", html: "x" },
      { ns: "live-artifact", type: "render", html: "x" },
      { ns: "mcp-app", type: "render", html: "x" },
    ]) {
      expect(parseRenderMessage(bad)).toBeNull()
    }
  })
})
