import { describe, expect, test } from "bun:test"

import {
  isNavigatingMessage,
  isShellReadyMessage,
  navigatingMessage,
  newSandboxFrameNonce,
  parseRenderMessage,
  renderMessage,
  SANDBOX_FRAME_NONCE_RE,
  SANDBOX_FRAME_NS,
  SANDBOX_FRAME_PATH,
  sandboxFrameUrl,
  shellReadyMessage,
} from "./sandbox-frame"

const N = "0123456789abcdef0123456789abcdef"
const OTHER = "ffffffffffffffffffffffffffffffff"

describe("sandbox frame protocol", () => {
  test("path and namespace are the documented constants", () => {
    expect(SANDBOX_FRAME_PATH).toBe("/sandbox/frame")
    expect(SANDBOX_FRAME_NS).toBe("sandbox-frame")
  })

  test("nonces are fresh, well-formed, and carried in the shell URL", () => {
    const a = newSandboxFrameNonce()
    const b = newSandboxFrameNonce()
    expect(a).not.toBe(b)
    expect(SANDBOX_FRAME_NONCE_RE.test(a)).toBe(true)
    expect(sandboxFrameUrl(a)).toBe(`/sandbox/frame?n=${a}`)
  })

  test("builders and validators round-trip for the same nonce", () => {
    expect(isShellReadyMessage(shellReadyMessage(N), N)).toBe(true)
    expect(isNavigatingMessage(navigatingMessage(N), N)).toBe(true)
    expect(parseRenderMessage(renderMessage("<p>hi</p>", N), N)).toBe("<p>hi</p>")
    // Empty HTML is still a valid (blank) render.
    expect(parseRenderMessage(renderMessage("", N), N)).toBe("")
  })

  test("a message for another navigation is rejected", () => {
    // The previous (already rendered) document replaying `shell-ready`
    // must not be handed the next artifact.
    expect(isShellReadyMessage(shellReadyMessage(OTHER), N)).toBe(false)
    expect(isNavigatingMessage(navigatingMessage(OTHER), N)).toBe(false)
    expect(parseRenderMessage(renderMessage("x", OTHER), N)).toBeNull()
    expect(isShellReadyMessage({ ns: SANDBOX_FRAME_NS, type: "shell-ready" }, N)).toBe(false)
  })

  test("survive structured clone (what postMessage does)", () => {
    expect(isShellReadyMessage(structuredClone(shellReadyMessage(N)), N)).toBe(true)
    expect(parseRenderMessage(structuredClone(renderMessage("<b>x</b>", N)), N)).toBe("<b>x</b>")
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
      { ns: SANDBOX_FRAME_NS, type: "render", nonce: N, html: "" },
      { ns: SANDBOX_FRAME_NS, type: "navigating", nonce: N },
      { ns: "live-artifact", type: "shell-ready", nonce: N },
      { ns: "live-artifact", type: "ready" },
      { ns: "mcp-app", type: "shell-ready", nonce: N },
    ]) {
      expect(isShellReadyMessage(bad, N)).toBe(false)
    }
  })

  test("parseRenderMessage rejects everything else", () => {
    for (const bad of [
      null,
      undefined,
      "<p>hi</p>",
      { ns: SANDBOX_FRAME_NS, type: "render", nonce: N },
      { ns: SANDBOX_FRAME_NS, type: "render", nonce: N, html: 1 },
      { ns: SANDBOX_FRAME_NS, type: "render", nonce: N, html: { toString: () => "x" } },
      { ns: SANDBOX_FRAME_NS, type: "render", html: "x" },
      { ns: SANDBOX_FRAME_NS, type: "shell-ready", nonce: N, html: "x" },
      { ns: "live-artifact", type: "render", nonce: N, html: "x" },
      { ns: "mcp-app", type: "render", nonce: N, html: "x" },
    ]) {
      expect(parseRenderMessage(bad, N)).toBeNull()
    }
  })
})
