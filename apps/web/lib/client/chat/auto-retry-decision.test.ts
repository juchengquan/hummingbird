/**
 * Tests for the auto-retry-once decision policy. Pure function — no
 * React, no timers, no fetch — so each branch is one assertion.
 */

import { describe, expect, test } from "bun:test"

import { shouldAutoRetry } from "./auto-retry-decision"

describe("shouldAutoRetry", () => {
  test("happy path: brand-new failed send retries once", () => {
    expect(
      shouldAutoRetry({
        isRetry: false,
        offline: false,
        placeholderEmpty: true,
      }),
    ).toBe(true)
  })

  test("skipped on the retry attempt itself (depth capped at one)", () => {
    expect(
      shouldAutoRetry({
        isRetry: true,
        offline: false,
        placeholderEmpty: true,
      }),
    ).toBe(false)
  })

  test("skipped when offline (1s nap won't fix a missing network)", () => {
    expect(
      shouldAutoRetry({
        isRetry: false,
        offline: true,
        placeholderEmpty: true,
      }),
    ).toBe(false)
  })

  test("skipped when the placeholder already has content (avoid duplicating output)", () => {
    expect(
      shouldAutoRetry({
        isRetry: false,
        offline: false,
        placeholderEmpty: false,
      }),
    ).toBe(false)
  })

  test("all three opt-outs OR — any one is enough to skip retry", () => {
    expect(
      shouldAutoRetry({ isRetry: true, offline: true, placeholderEmpty: true }),
    ).toBe(false)
    expect(
      shouldAutoRetry({ isRetry: true, offline: false, placeholderEmpty: false }),
    ).toBe(false)
    expect(
      shouldAutoRetry({ isRetry: false, offline: true, placeholderEmpty: false }),
    ).toBe(false)
  })
})
