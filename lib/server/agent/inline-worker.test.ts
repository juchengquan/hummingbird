import { describe, test, expect, afterEach } from "bun:test"

import { inlineAgentWorkerEnabled } from "./inline-worker"

const ORIG = process.env.INLINE_AGENT_WORKER

afterEach(() => {
  if (ORIG === undefined) {
    delete process.env.INLINE_AGENT_WORKER
  } else {
    process.env.INLINE_AGENT_WORKER = ORIG
  }
})

describe("inlineAgentWorkerEnabled", () => {
  test("default (env unset) → true", () => {
    delete process.env.INLINE_AGENT_WORKER
    expect(inlineAgentWorkerEnabled()).toBe(true)
  })

  test("'false' / '0' / 'off' / 'no' → false (case-insensitive)", () => {
    for (const v of ["false", "FALSE", "0", "off", "OFF", "no", "No"]) {
      process.env.INLINE_AGENT_WORKER = v
      expect(inlineAgentWorkerEnabled()).toBe(false)
    }
  })

  test("'true' / arbitrary truthy values → true", () => {
    for (const v of ["true", "1", "on", "yes", "anything-else"]) {
      process.env.INLINE_AGENT_WORKER = v
      expect(inlineAgentWorkerEnabled()).toBe(true)
    }
  })

  test("empty string → default-on (true)", () => {
    process.env.INLINE_AGENT_WORKER = ""
    expect(inlineAgentWorkerEnabled()).toBe(true)
  })
})
