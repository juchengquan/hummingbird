/**
 * Bounded-int field helper for per-skill `maxCalls`-style settings.
 *
 * Each skill that exposes a "max N calls per turn" knob needs the
 * same four constants — a default, a min, a max, and a clamp function
 * — and the clamp must agree with the bounds. Hand-rolling them per
 * file led to divergent semantics (one used `Math.floor` and no
 * lower-bound clamp, another used `Math.round` and bounded to
 * `[min, max]`) — see commit history around PR #17 for the cleanup.
 *
 * Use this helper to declare the field once. The returned bundle
 * exports the four pieces under stable names so each config module
 * can `export const { DEFAULT, ... } = makeBoundedIntField(...)` and
 * downstream consumers stay unchanged.
 */

export interface BoundedIntField {
  /** Default value when no value is provided. */
  DEFAULT: number
  /** Lower inclusive bound. */
  MIN: number
  /** Upper inclusive bound. */
  MAX: number
  /** Clamp + round + finite-check. Non-finite inputs (NaN / Infinity)
   *  fall back to DEFAULT; fractional inputs are rounded (banker's via
   *  `Math.round`); out-of-bounds inputs snap to the nearest bound. */
  clamp: (n: number) => number
}

export function makeBoundedIntField(opts: {
  default: number
  min: number
  max: number
}): BoundedIntField {
  const { default: def, min, max } = opts
  return {
    DEFAULT: def,
    MIN: min,
    MAX: max,
    clamp(n: number) {
      if (!Number.isFinite(n)) return def
      const rounded = Math.round(n)
      if (rounded < min) return min
      if (rounded > max) return max
      return rounded
    },
  }
}
