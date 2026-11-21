import { describe, expect, test } from "bun:test"

import type { Message } from "@/shared/types"

import { MAX_AGE_MS } from "./active-run"
import { memoryStorage } from "./fixtures"
import { baseFromCounts, clearRunBase, countsOf, loadRunBase, saveRunBase } from "./run-base"

const message: Message = {
  id: "a",
  role: "assistant",
  content: "Paused. Resumed text",
  reasoning: "r1r2",
  timestamp: new Date(),
  toolCalls: [
    { id: "t1", name: "lookup" },
    { id: "t2", name: "askUser" },
  ],
  routedModel: "anthropic/x",
}

describe("run base", () => {
  test("counts of a base, and the message cut back to them", () => {
    const counts = countsOf({ content: "Paused.", reasoning: "r1", toolCalls: [{ id: "t1", name: "lookup" }] })
    expect(counts).toEqual({
      content: 7,
      reasoning: 2,
      toolCalls: 1,
      generatedImages: 0,
      generatedFiles: 0,
      codeResults: 0,
      uiParts: 0,
      mcpApps: 0,
    })
    expect(baseFromCounts(message, counts)).toEqual({
      content: "Paused.",
      reasoning: "r1",
      toolCalls: [{ id: "t1", name: "lookup" }],
      generatedImages: undefined,
      generatedFiles: undefined,
      codeResults: undefined,
      uiParts: undefined,
      mcpApps: undefined,
      routedModel: "anthropic/x",
    })
  })

  test("save / load / clear per run; stale and malformed entries are dropped", () => {
    const storage = memoryStorage()
    const counts = countsOf({ content: "x" })
    saveRunBase("r1", counts, storage, 1000)
    expect(loadRunBase("r1", storage, 1000)).toEqual(counts)
    expect(loadRunBase("r1", storage, 1000 + MAX_AGE_MS + 1)).toBeNull()
    clearRunBase("r1", storage, 1000)
    expect(loadRunBase("r1", storage, 1000)).toBeNull()
    expect(storage.map.size).toBe(0)
    storage.setItem("humm.runBases", JSON.stringify({ r2: { content: -1, updatedAt: 1 } }))
    expect(loadRunBase("r2", storage, 1)).toBeNull()
    storage.setItem("humm.runBases", "{not json")
    expect(loadRunBase("r2", storage, 1)).toBeNull()
  })
})
