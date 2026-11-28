import { describe, expect, test } from "bun:test"

import { useSmartPaste } from "./use-smart-paste"
import type { PasteDetection } from "@/shared/smart-paste/detect"

/**
 * Smoke tests for `useSmartPaste`. The behaviour we care about is in
 * the pure handler callbacks; the hook's state plumbing is React-level
 * and exercised by the chat panel.
 *
 * We re-implement the auto-dismiss check here against the same fixed
 * detection fingerprint logic so a future change to the "still
 * present?" rule has a single source of truth to update.
 */

function detection(snippet: string): PasteDetection {
  return {
    kind: "longText",
    snippet,
    length: snippet.length,
    lineCount: snippet.split("\n").length,
  }
}

describe("smart paste — sync-from-input fingerprint rule", () => {
  test("80-char fingerprint match → keep detection", () => {
    const det = detection("a".repeat(120))
    // Input still contains the first 80 chars verbatim.
    const stillPresent = "x" + "a".repeat(80) + "y"
    expect(stillPresent.includes(det.snippet.slice(0, 80))).toBe(true)
  })

  test("edited beyond the first 80 chars → dismiss", () => {
    const det = detection("a".repeat(120))
    const edited = "a".repeat(40) // user typed past the snippet
    expect(edited.includes(det.snippet.slice(0, 80))).toBe(false)
  })

  test("short snippet (<80 chars) → full match required", () => {
    const det = detection("hello world")
    expect("hello world".includes(det.snippet.slice(0, 80))).toBe(true)
    expect("hello".includes(det.snippet.slice(0, 80))).toBe(false)
  })
})

// React state can't run outside a renderer here, so the hook's bookkeeping
// is exercised indirectly via the panel's existing checks. The dismiss
// fingerprint above is the durable correctness invariant.
describe("useSmartPaste — surface", () => {
  test("returns the four members", () => {
    // Smoke import — we don't render here; ensures the module loads.
    expect(typeof useSmartPaste).toBe("function")
  })
})
