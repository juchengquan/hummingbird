import { describe, expect, test } from "bun:test"

/**
 * Regression guard for the iframe's sandbox configuration. The
 * security model in docs/_done/PLAN-live-artifacts.md depends on:
 *
 *   - `sandbox="allow-scripts"` (and nothing else — crucially NOT
 *     `allow-same-origin`, which would let the iframe read parent
 *     cookies / storage and make same-origin fetches to our API).
 *   - `referrerpolicy="no-referrer"` so the iframe's outbound
 *     requests don't leak the user's URL.
 *
 * If a future PR adds another sandbox flag or removes the
 * referrerpolicy, this test trips. The fix is either: re-read the
 * security section of the plan, or update both the source and this
 * test deliberately together.
 *
 * We grep the source file rather than render the component because
 * `bun:test` doesn't ship jsdom in this repo and a full React
 * rendering harness isn't worth it for a single regression check.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

const FRAME_PATH = join(import.meta.dir, "live-artifact-frame.tsx")
const source = readFileSync(FRAME_PATH, "utf-8")

describe("LiveArtifactFrame — sandbox regression guard", () => {
  test("declares exactly `sandbox=\"allow-scripts\"`", () => {
    const matches = source.match(/sandbox="([^"]+)"/g) ?? []
    expect(matches.length).toBe(1)
    expect(matches[0]).toBe(`sandbox="allow-scripts"`)
  })

  // Per-flag checks read only `sandbox="…"` attribute values, not the
  // surrounding source. That way the comment that documents *why* we
  // avoid each flag doesn't trip the test, but a real attribute
  // change does.
  const FORBIDDEN_FLAGS: string[] = [
    "allow-same-origin", // would let iframe read parent cookies / storage
    "allow-top-navigation", // would let iframe redirect the parent
    "allow-popups", // would allow window.open surprises
    "allow-modals", // would allow alert/confirm/prompt blocking
    "allow-forms", // would allow form submission to external hosts
  ]

  for (const flag of FORBIDDEN_FLAGS) {
    test(`sandbox attribute never grants \`${flag}\``, () => {
      const matches = source.match(/sandbox="([^"]+)"/g) ?? []
      for (const m of matches) {
        expect(m).not.toContain(flag)
      }
    })
  }

  test("sets referrerpolicy='no-referrer'", () => {
    expect(source).toMatch(/referrerPolicy="no-referrer"/)
  })
})
