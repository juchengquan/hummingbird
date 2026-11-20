import { afterEach, describe, expect, test } from "bun:test"

import { getEnv, resetEnvCacheForTest } from "../src/env"

const ORIGINAL = process.env.WORKER_DRY_RUN

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WORKER_DRY_RUN
  else process.env.WORKER_DRY_RUN = ORIGINAL
  resetEnvCacheForTest()
})

function dryRunFor(value: string | undefined): boolean {
  if (value === undefined) delete process.env.WORKER_DRY_RUN
  else process.env.WORKER_DRY_RUN = value
  resetEnvCacheForTest()
  return getEnv().WORKER_DRY_RUN
}

describe("WORKER_DRY_RUN parsing", () => {
  // `z.coerce.boolean()` turned the string "false" into `true`.
  test.each([
    ["false", false],
    ["FALSE", false],
    ["0", false],
    [" no ", false],
    ["off", false],
    ["true", true],
    ["True", true],
    ["1", true],
    ["yes", true],
    ["on", true],
  ] as const)("%p → %p", (raw, expected) => {
    expect(dryRunFor(raw)).toBe(expected)
  })

  test("unset or empty → default true", () => {
    expect(dryRunFor(undefined)).toBe(true)
    expect(dryRunFor("")).toBe(true)
  })

  test("garbage fails boot instead of guessing", () => {
    expect(() => dryRunFor("nope")).toThrow(/WORKER_DRY_RUN/)
  })
})
