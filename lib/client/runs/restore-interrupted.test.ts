/** The reload rebuild of interrupted turns from the active-run pointers. */

import { describe, expect, test } from "bun:test"

import type { ActiveRunRecord } from "./active-run"
import type { InterruptedTurn } from "./chat-bridge"
import { RunsError } from "./errors"
import { loadFixture } from "./fixtures"
import { toPendingInterrupt } from "./interrupts"
import { restoreInterruptedTurns, type RestoreDeps } from "./restore-interrupted"
import type { Interrupt, Run } from "./types"

const closing = loadFixture("memory-interrupt-signed_in").items.at(-1)!.event as unknown as {
  outcome: { interrupts: Interrupt[] }
}
const approval = toPendingInterrupt(closing.outcome.interrupts[0])

describe("restoreInterruptedTurns", () => {
  const runId = "33333333-3333-4333-8333-333333333333"
  const record = (over: Partial<ActiveRunRecord> = {}): ActiveRunRecord => ({
    runId,
    threadId: "44444444-4444-4444-8444-444444444444",
    conversationId: "conv-1",
    messageId: "msg-1",
    status: "interrupted",
    cursor: "6",
    anonymous: false,
    model: "anthropic/claude-haiku-4.5",
    updatedAt: "2026-11-21T12:00:00.000Z",
    ...over,
  })

  function harness(over: Partial<RestoreDeps> & { run?: Partial<Run> | Error } = {}) {
    const set: InterruptedTurn[] = []
    const cleared: string[] = []
    const fetched: string[] = []
    const deps: RestoreDeps = {
      target: { baseUrl: "", authToken: "tok" },
      records: [record()],
      messageExists: () => true,
      hasTurn: () => false,
      getRun: async (id) => {
        fetched.push(id)
        if (over.run instanceof Error) throw over.run
        return { status: "interrupted", openInterrupts: [approval.raw], ...over.run } as Run
      },
      setTurn: (t) => set.push(t),
      clearPointer: (conv, id) => cleared.push(`${conv}:${id}`),
      ...over,
    }
    return { deps, set, cleared, fetched }
  }

  test("an interrupted pointer becomes the turn again", async () => {
    const h = harness()
    expect(await restoreInterruptedTurns(h.deps)).toEqual([{ runId, result: "restored" }])
    expect(h.set).toEqual([
      {
        conversationId: "conv-1",
        messageId: "msg-1",
        runId,
        threadId: "44444444-4444-4444-8444-444444444444",
        interrupts: [approval],
        anonymous: false,
        model: "anthropic/claude-haiku-4.5",
      },
    ])
    expect(h.cleared).toEqual([])
  })

  test("running pointers are left to the rejoin path", async () => {
    const h = harness({ records: [record({ status: "running" })] })
    expect(await restoreInterruptedTurns(h.deps)).toEqual([])
    expect(h.fetched).toEqual([])
  })

  test("the backend forgot the run (404) → pointer cleared, no card", async () => {
    const h = harness({ run: new RunsError("http", "not_found", "gone", 404) })
    expect(await restoreInterruptedTurns(h.deps)).toEqual([{ runId, result: "cleared" }])
    expect(h.cleared).toEqual([`conv-1:${runId}`])
    expect(h.set).toEqual([])
  })

  test("no longer interrupted → pointer cleared, no card", async () => {
    const h = harness({ run: { status: "cancelled", openInterrupts: [] } })
    expect(await restoreInterruptedTurns(h.deps)).toEqual([{ runId, result: "cleared" }])
    expect(h.cleared).toHaveLength(1)
  })

  test("a transient error keeps the pointer for next time", async () => {
    const h = harness({ run: new RunsError("network", "network", "offline") })
    expect(await restoreInterruptedTurns(h.deps)).toEqual([{ runId, result: "skipped", reason: "network" }])
    expect(h.cleared).toEqual([])
  })

  test("skipped without a request: message gone, turn shown, identity changed", async () => {
    for (const [over, reason] of [
      [{ messageExists: () => false }, "message-missing"],
      [{ hasTurn: () => true }, "shown"],
      [{ records: [record({ anonymous: true })] }, "identity-changed"],
    ] as const) {
      const h = harness(over)
      expect(await restoreInterruptedTurns(h.deps)).toEqual([{ runId, result: "skipped", reason }])
      expect(h.fetched).toEqual([])
      expect(h.cleared).toEqual([])
    }
  })

  test("a live turn that appeared during the request wins", async () => {
    let calls = 0
    const h = harness({ hasTurn: () => calls++ > 0 })
    expect(await restoreInterruptedTurns(h.deps)).toEqual([{ runId, result: "skipped", reason: "shown" }])
    expect(h.set).toEqual([])
  })
})
