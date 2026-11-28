import { describe, expect, test } from "bun:test"

import type { PersistedUiPart } from "@/shared/generative-ui/schemas"
import type { Message } from "@/shared/types"

import { MAX_AGE_MS } from "./active-run"
import { memoryStorage } from "./fixtures"
import { baseFromCounts, clearRunBase, countsOf, loadRunBase, saveRunBase, withAnsweredUiParts } from "./run-base"

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

describe("withAnsweredUiParts", () => {
  const msg = (uiParts?: Message["uiParts"]): Message => ({
    id: "a",
    role: "assistant",
    content: "x",
    timestamp: new Date(0),
    ...(uiParts ? { uiParts } : {}),
  })
  const part = (id: string, extra: Partial<PersistedUiPart> = {}): PersistedUiPart => ({
    id,
    kind: "confirm",
    props: { prompt: "?" },
    ...extra,
  })
  const answer = { kind: "confirm" as const, confirmed: true }

  test("appends a new part, answers a present unanswered one, leaves an answered one", () => {
    const answeredOld = part("old", { answeredAt: "t0", answer: { kind: "confirm", confirmed: false } })
    const out = withAnsweredUiParts(msg([part("p"), answeredOld]), [
      part("p", { answeredAt: "t1", answer }),
      part("old", { answeredAt: "t1", answer }),
      part("new", { answeredAt: "t1", answer }),
    ])
    expect(out.uiParts).toEqual([
      part("p", { answeredAt: "t1", answer }),
      answeredOld,
      part("new", { answeredAt: "t1", answer }),
    ])
    expect(countsOf(out).uiParts).toBe(3)
  })

  test("no parts → the same message", () => {
    const m = msg()
    expect(withAnsweredUiParts(m, [])).toBe(m)
  })
})
