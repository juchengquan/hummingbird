import { describe, expect, test } from "bun:test"

import {
  finishToolCall,
  sanitizeToolResults,
  startToolCall,
  toPersistedToolCalls,
} from "./tool-call-buffer"

const result = { title: "T", url: "https://example.test", snippet: "S" }

describe("tool-call buffer", () => {
  test("a full stream's calls are persisted (call → result → persist)", () => {
    let calls = startToolCall([], {
      id: "t1",
      name: "webSearch",
      args: { query: "react" },
    })
    calls = startToolCall(calls, { id: "t2", name: "other" })
    calls = finishToolCall(calls, {
      id: "t1",
      summary: "1 result",
      results: [result, { title: 1 }],
    })
    calls = finishToolCall(calls, { id: "t2", summary: "ok", results: [] })

    expect(toPersistedToolCalls(calls)).toEqual([
      {
        id: "t1",
        name: "webSearch",
        argsLabel: "react",
        summary: "1 result",
        results: [result],
      },
      // Empty results array is omitted from the durable record.
      { id: "t2", name: "other", argsLabel: undefined, summary: "ok" },
    ])
  })

  test("running (never-returned) calls are dropped from the durable record", () => {
    const calls = startToolCall([], { id: "t1", name: "webSearch" })
    expect(calls[0].status).toBe("running")
    expect(toPersistedToolCalls(calls)).toEqual([])
  })

  test("startToolCall only labels string queries", () => {
    expect(
      startToolCall([], { id: "t", name: "n", args: { query: 3 } })[0].argsLabel
    ).toBeUndefined()
  })

  test("buffer updates are immutable", () => {
    const a = startToolCall([], { id: "t1", name: "n" })
    const b = finishToolCall(a, { id: "t1", summary: "done" })
    expect(a[0].status).toBe("running")
    expect(b[0].status).toBe("done")
  })

  test("sanitizeToolResults: non-array → undefined; keeps well-formed entries", () => {
    expect(sanitizeToolResults(undefined)).toBeUndefined()
    expect(sanitizeToolResults([result, null, { url: "x" }])).toEqual([result])
  })
})
