import { describe, expect, test } from "bun:test"

import { gateLiveTailBatch, isTerminalEvent, type TaskEvent } from "./events"

function ev(seq: number, e: Partial<TaskEvent> & { kind: TaskEvent["kind"] }): TaskEvent {
  return { runId: "r1", seq, step: 0, createdAt: "t", ...e } as TaskEvent
}

const token = (seq: number, text = "x") => ev(seq, { kind: "token", text })
const result = (seq: number) => ev(seq, { kind: "result", status: "done" })
const marker = (seq: number, resumedFromSeq: number) =>
  ev(seq, { kind: "status", status: "running", resumedFromSeq })

const seqs = (events: TaskEvent[]) => events.map((e) => e.seq)

describe("isTerminalEvent", () => {
  test("result and terminal status are terminal; others are not", () => {
    expect(isTerminalEvent(result(1))).toBe(true)
    expect(isTerminalEvent(ev(1, { kind: "status", status: "cancelled" }))).toBe(true)
    expect(isTerminalEvent(ev(1, { kind: "status", status: "paused" }))).toBe(false)
    expect(isTerminalEvent(token(1))).toBe(false)
  })
})

describe("gateLiveTailBatch — a result is terminal only once the row is", () => {
  test("no terminal event: deliver everything, keep tailing", () => {
    const batch = gateLiveTailBatch([token(2), token(3)], false)
    expect(seqs(batch.deliver)).toEqual([2, 3])
    expect(batch.cursor).toBe(3)
    expect(batch.settled).toBe(false)
  })

  test("empty batch leaves the cursor alone", () => {
    expect(gateLiveTailBatch([], false)).toEqual({ deliver: [], cursor: null, settled: false })
  })

  test("result + terminal row: deliver it and settle", () => {
    const batch = gateLiveTailBatch([token(2), result(3)], true)
    expect(seqs(batch.deliver)).toEqual([2, 3])
    expect(batch.cursor).toBe(3)
    expect(batch.settled).toBe(true)
  })

  test("result while the row is still live: hold it back, cursor stays before it", () => {
    // A worker died after writing `result` but before settling the task.
    const batch = gateLiveTailBatch([token(2), result(3)], false)
    expect(seqs(batch.deliver)).toEqual([2])
    expect(batch.cursor).toBe(2)
    expect(batch.settled).toBe(false)
  })

  test("held result superseded by the reclaimed re-run's marker is never delivered", () => {
    // Next poll re-reads from the held result: the re-run has opened with
    // a resume marker discarding seqs 2..4 and gone on to settle.
    const batch = gateLiveTailBatch(
      [result(3), marker(5, 1), token(6, "real"), result(7)],
      true
    )
    expect(seqs(batch.deliver)).toEqual([5, 6, 7])
    expect(batch.cursor).toBe(7)
    expect(batch.settled).toBe(true)
  })

  test("superseded result with the re-run still going: deliver past it, keep tailing", () => {
    const batch = gateLiveTailBatch([result(3), marker(5, 1), token(6)], false)
    expect(seqs(batch.deliver)).toEqual([5, 6])
    expect(batch.cursor).toBe(6)
    expect(batch.settled).toBe(false)
  })

  test("non-terminal superseded events still flow (the client's fold rolls them back)", () => {
    const batch = gateLiveTailBatch([token(2), marker(4, 1), token(5)], false)
    expect(seqs(batch.deliver)).toEqual([2, 4, 5])
  })

  test("cancelled status is gated the same way", () => {
    const cancelled = ev(4, { kind: "status", status: "cancelled" })
    expect(gateLiveTailBatch([token(3), cancelled], false).settled).toBe(false)
    expect(gateLiveTailBatch([token(3), cancelled], true).settled).toBe(true)
  })
})
