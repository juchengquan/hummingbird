import { describe, expect, test } from "bun:test"

import { triggerDownload } from "./download"

describe("triggerDownload", () => {
  test("refuses script / unknown-scheme URLs before touching the DOM", () => {
    // No `document` in this runtime: a refusal must return before any
    // anchor is created.
    expect(triggerDownload("javascript:alert(1)", "x")).toBe(false)
    expect(triggerDownload("java\tscript:alert(1)", "x")).toBe(false)
    expect(triggerDownload("vbscript:x", "x")).toBe(false)
    expect(triggerDownload("file:///etc/passwd", "x")).toBe(false)
  })
})
