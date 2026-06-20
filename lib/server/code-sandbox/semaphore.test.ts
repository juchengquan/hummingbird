import { describe, expect, test } from "bun:test"

import { createSemaphore } from "./semaphore"

describe("createSemaphore", () => {
  test("allows up to `max` concurrent holders; further acquires queue", async () => {
    const s = createSemaphore(2)
    await s.acquire()
    await s.acquire()
    expect(s.active()).toBe(2)

    let third = false
    const p = s.acquire().then(() => {
      third = true
    })
    await Promise.resolve()
    expect(third).toBe(false)
    expect(s.waiting()).toBe(1)

    s.release()
    await p
    expect(third).toBe(true)
    expect(s.active()).toBe(2)
  })

  test("release with no waiters decrements active", async () => {
    const s = createSemaphore(1)
    await s.acquire()
    expect(s.active()).toBe(1)
    s.release()
    expect(s.active()).toBe(0)
  })

  test("never exceeds max under a burst", async () => {
    const s = createSemaphore(2)
    let running = 0
    let peak = 0
    const task = async () => {
      await s.acquire()
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 3))
      running--
      s.release()
    }
    await Promise.all(Array.from({ length: 8 }, task))
    expect(peak).toBeLessThanOrEqual(2)
    expect(s.active()).toBe(0)
  })

  test("abort while queued rejects and removes the waiter", async () => {
    const s = createSemaphore(1)
    await s.acquire()
    const ac = new AbortController()
    const p = s.acquire(ac.signal)
    await Promise.resolve()
    expect(s.waiting()).toBe(1)

    ac.abort()
    await expect(p).rejects.toThrow()
    expect(s.waiting()).toBe(0)

    // The original slot still releases cleanly — no ghost waiter resurrected.
    s.release()
    expect(s.active()).toBe(0)
  })

  test("acquire with an already-aborted signal rejects without taking a slot", async () => {
    const s = createSemaphore(1)
    const ac = new AbortController()
    ac.abort()
    await expect(s.acquire(ac.signal)).rejects.toThrow()
    expect(s.active()).toBe(0)
  })
})
