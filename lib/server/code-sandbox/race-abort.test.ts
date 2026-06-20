import { describe, expect, test } from "bun:test"

import { ABORTED, raceAbort } from "./race-abort"

describe("raceAbort", () => {
  test("no signal → resolves with the promise value", async () => {
    expect(await raceAbort(Promise.resolve(7))).toBe(7)
  })

  test("promise resolves before abort → value", async () => {
    const ac = new AbortController()
    expect(await raceAbort(Promise.resolve("ok"), ac.signal)).toBe("ok")
  })

  test("abort before the promise settles → ABORTED sentinel", async () => {
    const ac = new AbortController()
    const never = new Promise<number>(() => {})
    const p = raceAbort(never, ac.signal)
    ac.abort()
    expect(await p).toBe(ABORTED)
  })

  test("already-aborted signal → ABORTED immediately", async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await raceAbort(new Promise<number>(() => {}), ac.signal)).toBe(ABORTED)
  })

  test("promise rejects before abort → rejection propagates", async () => {
    const ac = new AbortController()
    await expect(raceAbort(Promise.reject(new Error("boom")), ac.signal)).rejects.toThrow("boom")
  })

  test("a rejection AFTER abort is swallowed (no unhandled rejection)", async () => {
    const ac = new AbortController()
    let rej: (e: Error) => void = () => {}
    const promise = new Promise<number>((_, r) => {
      rej = r
    })
    const p = raceAbort(promise, ac.signal)
    ac.abort()
    expect(await p).toBe(ABORTED)
    rej(new Error("late")) // must not surface as an unhandled rejection
    await Promise.resolve()
  })
})
