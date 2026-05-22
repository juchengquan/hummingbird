import { describe, expect, test } from "bun:test"
import { makeBoundedIntField } from "./bounded-int"

describe("makeBoundedIntField", () => {
  const field = makeBoundedIntField({ default: 5, min: 1, max: 20 })

  test("returns the constants as declared", () => {
    expect(field.DEFAULT).toBe(5)
    expect(field.MIN).toBe(1)
    expect(field.MAX).toBe(20)
  })

  test("in-bounds integer passes through unchanged", () => {
    expect(field.clamp(10)).toBe(10)
    expect(field.clamp(1)).toBe(1)
    expect(field.clamp(20)).toBe(20)
  })

  test("below min snaps to min", () => {
    expect(field.clamp(0)).toBe(1)
    expect(field.clamp(-5)).toBe(1)
  })

  test("above max snaps to max", () => {
    expect(field.clamp(21)).toBe(20)
    expect(field.clamp(1000)).toBe(20)
  })

  test("fractional input rounds half-to-even (Math.round semantics)", () => {
    expect(field.clamp(2.4)).toBe(2)
    expect(field.clamp(2.6)).toBe(3)
    // 2.5 → 3 under Math.round (JS rounds half up for positive numbers)
    expect(field.clamp(2.5)).toBe(3)
  })

  test("non-finite input falls back to default", () => {
    expect(field.clamp(NaN)).toBe(5)
    expect(field.clamp(Infinity)).toBe(5)
    expect(field.clamp(-Infinity)).toBe(5)
  })

  test("two independent fields don't share state", () => {
    const a = makeBoundedIntField({ default: 3, min: 1, max: 10 })
    const b = makeBoundedIntField({ default: 5, min: 1, max: 20 })
    expect(a.clamp(15)).toBe(10)
    expect(b.clamp(15)).toBe(15)
    expect(a.DEFAULT).toBe(3)
    expect(b.DEFAULT).toBe(5)
  })
})
