import { describe, expect, test } from "bun:test"

import { isTerminalStatus } from "./events"

describe("isTerminalStatus", () => {
  test("done / failed / cancelled are terminal; queued / running / paused are not", () => {
    expect(isTerminalStatus("done")).toBe(true)
    expect(isTerminalStatus("failed")).toBe(true)
    expect(isTerminalStatus("cancelled")).toBe(true)
    expect(isTerminalStatus("queued")).toBe(false)
    expect(isTerminalStatus("running")).toBe(false)
    expect(isTerminalStatus("paused")).toBe(false)
  })
})
