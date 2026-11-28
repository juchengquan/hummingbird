import { describe, expect, test } from "bun:test"
import {
  clampMaxImageGenerations,
  DEFAULT_IMAGE_GEN_ASPECT_RATIO,
  DEFAULT_MAX_IMAGE_GENERATIONS,
  MAX_MAX_IMAGE_GENERATIONS,
  MIN_MAX_IMAGE_GENERATIONS,
  resolveImageGenConfig,
} from "./image-gen-config"

describe("clampMaxImageGenerations", () => {
  test("returns default for non-finite input", () => {
    expect(clampMaxImageGenerations(NaN)).toBe(DEFAULT_MAX_IMAGE_GENERATIONS)
    expect(clampMaxImageGenerations(Infinity)).toBe(DEFAULT_MAX_IMAGE_GENERATIONS)
  })
  test("snaps to MIN", () => {
    expect(clampMaxImageGenerations(0)).toBe(MIN_MAX_IMAGE_GENERATIONS)
    expect(clampMaxImageGenerations(-5)).toBe(MIN_MAX_IMAGE_GENERATIONS)
  })
  test("snaps to MAX", () => {
    expect(clampMaxImageGenerations(99)).toBe(MAX_MAX_IMAGE_GENERATIONS)
  })
  test("rounds fractional inputs", () => {
    expect(clampMaxImageGenerations(2.4)).toBe(2)
    expect(clampMaxImageGenerations(2.6)).toBe(3)
  })
})

describe("resolveImageGenConfig — cascade", () => {
  test("nothing set → defaults", () => {
    const c = resolveImageGenConfig(undefined, undefined)
    expect(c.maxCalls).toBe(DEFAULT_MAX_IMAGE_GENERATIONS)
    expect(c.aspectRatio).toBe(DEFAULT_IMAGE_GEN_ASPECT_RATIO)
  })

  test("workspace overrides default", () => {
    const c = resolveImageGenConfig({ maxCalls: 4 }, undefined)
    expect(c.maxCalls).toBe(4)
  })

  test("conversation overrides workspace", () => {
    const c = resolveImageGenConfig({ maxCalls: 4 }, { maxCalls: 2 })
    expect(c.maxCalls).toBe(2)
  })

  test("conversation null fields fall through to workspace", () => {
    // conversation has aspectRatio but no maxCalls → maxCalls from workspace
    const c = resolveImageGenConfig(
      { maxCalls: 5 },
      { aspectRatio: "16:9" }
    )
    expect(c.maxCalls).toBe(5)
    expect(c.aspectRatio).toBe("16:9")
  })

  test("clamps and validates the cascade output", () => {
    const c = resolveImageGenConfig({ maxCalls: 99 }, undefined)
    expect(c.maxCalls).toBe(MAX_MAX_IMAGE_GENERATIONS)
  })

  test("unknown aspect ratio string falls back to default", () => {
    const c = resolveImageGenConfig(
      undefined,
      { aspectRatio: "21:9" as never }
    )
    expect(c.aspectRatio).toBe(DEFAULT_IMAGE_GEN_ASPECT_RATIO)
  })
})
