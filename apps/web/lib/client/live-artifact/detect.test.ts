import { describe, expect, test } from "bun:test"

import {
  detectArtifactShell,
  INLINE_RENDER_MAX_CONTENT_CHARS,
  isSmallEnoughForInline,
} from "./detect"

describe("detectArtifactShell — explicit languages", () => {
  test("tsx → tsx shell", () => {
    expect(detectArtifactShell({ language: "tsx", content: "<div/>" }))
      .toEqual({ renderable: true, shell: "tsx" })
  })
  test("jsx → tsx shell (same path)", () => {
    expect(detectArtifactShell({ language: "jsx", content: "<div/>" }))
      .toEqual({ renderable: true, shell: "tsx" })
  })
  test("react alias → tsx", () => {
    expect(detectArtifactShell({ language: "react", content: "<div/>" }))
      .toEqual({ renderable: true, shell: "tsx" })
  })
  test("html → html shell", () => {
    expect(detectArtifactShell({ language: "html", content: "<p>hi</p>" }))
      .toEqual({ renderable: true, shell: "html" })
  })
  test("svg → svg shell", () => {
    expect(detectArtifactShell({ language: "svg", content: "<svg/>" }))
      .toEqual({ renderable: true, shell: "svg" })
  })
  test("mermaid → mermaid shell", () => {
    expect(detectArtifactShell({ language: "mermaid", content: "graph TD" }))
      .toEqual({ renderable: true, shell: "mermaid" })
  })
  test("mmd alias → mermaid", () => {
    expect(detectArtifactShell({ language: "mmd", content: "graph TD" }))
      .toEqual({ renderable: true, shell: "mermaid" })
  })
  test("case insensitive (TSX, HTML)", () => {
    expect(detectArtifactShell({ language: "TSX", content: "" }))
      .toEqual({ renderable: true, shell: "tsx" })
    expect(detectArtifactShell({ language: "HTML", content: "" }))
      .toEqual({ renderable: true, shell: "html" })
  })
  test("whitespace-padded language", () => {
    expect(detectArtifactShell({ language: "  tsx  ", content: "" }))
      .toEqual({ renderable: true, shell: "tsx" })
  })
})

describe("detectArtifactShell — non-renderable languages", () => {
  test("python is never renderable", () => {
    expect(detectArtifactShell({ language: "python", content: "<svg/>" }))
      .toEqual({ renderable: false, shell: null })
  })
  test("bash is never renderable", () => {
    expect(detectArtifactShell({ language: "bash", content: "<!doctype html>" }))
      .toEqual({ renderable: false, shell: null })
  })
  test("json is never renderable (already has its own viewer)", () => {
    expect(detectArtifactShell({ language: "json", content: "<svg/>" }))
      .toEqual({ renderable: false, shell: null })
  })
})

describe("detectArtifactShell — content sniffs (language null/unknown)", () => {
  test("<!doctype html> detected without language", () => {
    expect(detectArtifactShell({ language: null, content: "<!doctype html><html></html>" }))
      .toEqual({ renderable: true, shell: "html" })
  })
  test("<!DOCTYPE HTML> case-insensitive", () => {
    expect(detectArtifactShell({ language: null, content: "<!DOCTYPE HTML><html></html>" }))
      .toEqual({ renderable: true, shell: "html" })
  })
  test("leading whitespace + doctype still detected", () => {
    expect(detectArtifactShell({ language: null, content: "\n  <!doctype html>" }))
      .toEqual({ renderable: true, shell: "html" })
  })
  test("<svg> at start detected", () => {
    expect(detectArtifactShell({ language: null, content: "<svg xmlns=\"...\"></svg>" }))
      .toEqual({ renderable: true, shell: "svg" })
  })
  test("<html> tag at start detected", () => {
    expect(detectArtifactShell({ language: null, content: "<html><body></body></html>" }))
      .toEqual({ renderable: true, shell: "html" })
  })
  test("text language permits sniffing", () => {
    expect(detectArtifactShell({ language: "text", content: "<!doctype html>" }))
      .toEqual({ renderable: true, shell: "html" })
  })
  test("plain text language permits sniffing", () => {
    expect(detectArtifactShell({ language: "plain", content: "<svg/>" }))
      .toEqual({ renderable: true, shell: "svg" })
  })
  test("bare HTML snippet without doctype/html tag — not renderable", () => {
    // We don't want to render every random `<p>...</p>` fragment as HTML.
    // If the model wanted that it should fence with `html`.
    expect(detectArtifactShell({ language: null, content: "<p>hello</p>" }))
      .toEqual({ renderable: false, shell: null })
  })
})

describe("detectArtifactShell — non-renderable inputs", () => {
  test("empty content", () => {
    expect(detectArtifactShell({ language: null, content: "" }))
      .toEqual({ renderable: false, shell: null })
  })
  test("whitespace-only content", () => {
    expect(detectArtifactShell({ language: null, content: "   \n  " }))
      .toEqual({ renderable: false, shell: null })
  })
  test("plain prose without HTML", () => {
    expect(detectArtifactShell({ language: null, content: "Just some text." }))
      .toEqual({ renderable: false, shell: null })
  })
})

describe("isSmallEnoughForInline", () => {
  test("short content is small", () => {
    expect(isSmallEnoughForInline("<div>hi</div>")).toBe(true)
  })
  test("content at the cap boundary is small", () => {
    expect(isSmallEnoughForInline("x".repeat(INLINE_RENDER_MAX_CONTENT_CHARS))).toBe(true)
  })
  test("content past the cap is not small", () => {
    expect(isSmallEnoughForInline("x".repeat(INLINE_RENDER_MAX_CONTENT_CHARS + 1))).toBe(false)
  })
})
