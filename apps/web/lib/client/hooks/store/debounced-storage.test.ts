/**
 * Tests for the debounced localStorage adapter that backs the main
 * Zustand store's `persist` middleware. The wrapper's job: collapse
 * bursts of setItem into one underlying write per quiet window,
 * while keeping reads consistent with the most recent set.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { debouncedStorage } from "./debounced-storage"
import {
  __resetQuotaToastForTests,
  isQuotaExceededError,
  notifyStorageQuotaExceeded,
} from "./quota-toast"

class FakeStorage implements Storage {
  private map = new Map<string, string>()
  writeCount = 0
  removeCount = 0

  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }
  getItem(name: string): string | null {
    return this.map.get(name) ?? null
  }
  setItem(name: string, value: string): void {
    this.writeCount++
    this.map.set(name, value)
  }
  removeItem(name: string): void {
    this.removeCount++
    this.map.delete(name)
  }
}

let target: FakeStorage

beforeEach(() => {
  target = new FakeStorage()
})

afterEach(() => {
  // Clean up any leftover timers from tests that didn't await flushes.
})

/** Wait for the next macrotask + the debounce window so any pending
 *  setTimeout fires. */
async function tick(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe("debouncedStorage", () => {
  test("getItem reads through to the target when nothing is pending", () => {
    target.setItem("k", "v")
    const s = debouncedStorage({ target, delayMs: 50 })
    expect(s.getItem("k")).toBe("v")
  })

  test("setItem coalesces bursts into one target write", async () => {
    const s = debouncedStorage({ target, delayMs: 30 })
    s.setItem("k", "a")
    s.setItem("k", "b")
    s.setItem("k", "c")
    // No write yet — still in the debounce window.
    expect(target.writeCount).toBe(0)
    await tick(60)
    // Exactly one write, with the most recent value.
    expect(target.writeCount).toBe(1)
    expect(target.getItem("k")).toBe("c")
  })

  test("getItem returns the pending value before the timer fires (read-your-write)", () => {
    target.setItem("k", "old")
    const s = debouncedStorage({ target, delayMs: 30 })
    s.setItem("k", "new")
    // Hasn't flushed to the target yet, but the read sees the pending value.
    expect(s.getItem("k")).toBe("new")
    expect(target.getItem("k")).toBe("old")
  })

  test("different keys debounce independently", async () => {
    const s = debouncedStorage({ target, delayMs: 30 })
    s.setItem("a", "1")
    s.setItem("b", "2")
    await tick(60)
    expect(target.writeCount).toBe(2)
    expect(target.getItem("a")).toBe("1")
    expect(target.getItem("b")).toBe("2")
  })

  test("removeItem cancels any pending write for that key + deletes from target", async () => {
    target.setItem("k", "old") // 1 write before the wrapper exists
    const s = debouncedStorage({ target, delayMs: 30 })
    s.setItem("k", "new") // pending; no target write yet
    s.removeItem("k") // cancels pending + calls target.removeItem
    await tick(60)
    // The pending "new" was cancelled — no additional target writes
    // landed. removeCount went up by 1.
    expect(target.writeCount).toBe(1)
    expect(target.removeCount).toBe(1)
    expect(target.getItem("k")).toBeNull()
    expect(s.getItem("k")).toBeNull()
  })

  test("a second setItem within the window resets the timer (debounce, not throttle)", async () => {
    const s = debouncedStorage({ target, delayMs: 30 })
    s.setItem("k", "a")
    await tick(20)
    expect(target.writeCount).toBe(0)
    s.setItem("k", "b")
    await tick(20)
    // The second set reset the timer; total elapsed is 40ms but only
    // 20ms since the last set → no write yet.
    expect(target.writeCount).toBe(0)
    await tick(20)
    expect(target.writeCount).toBe(1)
    expect(target.getItem("k")).toBe("b")
  })

  test("SSR / no-target builds a no-op storage that doesn't throw", () => {
    const s = debouncedStorage({ target: undefined as unknown as Storage })
    expect(s.getItem("k")).toBeNull()
    s.setItem("k", "v")
    s.removeItem("k")
    expect(s.getItem("k")).toBeNull()
  })
})

describe("debouncedStorage — cross-tab hooks", () => {
  test("hasPending / discardPending drop the buffered write unwritten", async () => {
    target.setItem("k", "theirs")
    target.writeCount = 0
    const s = debouncedStorage({ target, delayMs: 30 })
    s.setItem("k", "ours")
    expect(s.hasPending("k")).toBe(true)
    s.discardPending("k")
    expect(s.hasPending("k")).toBe(false)
    // Reads go back to the target; the timer never writes.
    expect(s.getItem("k")).toBe("theirs")
    await tick(60)
    expect(target.writeCount).toBe(0)
    expect(target.getItem("k")).toBe("theirs")
  })

  test("subscribeFlush fires after each real write, until unsubscribed", async () => {
    const s = debouncedStorage({ target, delayMs: 20 })
    const flushed: string[] = []
    const off = s.subscribeFlush((name) => flushed.push(name))
    s.setItem("k", "1")
    await tick(40)
    expect(flushed).toEqual(["k"])
    off()
    s.setItem("k", "2")
    await tick(40)
    expect(flushed).toEqual(["k"])
  })
})

describe("quota exceeded handling", () => {
  class FullStorage extends FakeStorage {
    constructor(private readonly error: unknown) {
      super()
    }
    override setItem(): void {
      throw this.error
    }
  }

  test("isQuotaExceededError recognises the spec name, Firefox's legacy name, and codes 22 / 1014", () => {
    expect(isQuotaExceededError(new DOMException("full", "QuotaExceededError"))).toBe(true)
    expect(isQuotaExceededError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true)
    expect(isQuotaExceededError({ name: "Error", code: 22 })).toBe(true)
    expect(isQuotaExceededError({ name: "Error", code: 1014 })).toBe(true)
    expect(isQuotaExceededError(new Error("SecurityError"))).toBe(false)
    expect(isQuotaExceededError(null)).toBe(false)
  })

  test("a quota failure on flush calls onQuotaExceeded and keeps the old no-throw behaviour", async () => {
    const seen: unknown[] = []
    const err = new DOMException("full", "QuotaExceededError")
    const s = debouncedStorage({
      target: new FullStorage(err),
      delayMs: 10,
      onQuotaExceeded: (e) => seen.push(e),
    })
    s.setItem("k", "v")
    await tick(30)
    expect(seen).toEqual([err])
    expect(s.hasPending("k")).toBe(false)
  })

  test("non-quota storage errors stay silent", async () => {
    const seen: unknown[] = []
    const s = debouncedStorage({
      target: new FullStorage(new Error("SecurityError")),
      delayMs: 10,
      onQuotaExceeded: (e) => seen.push(e),
    })
    s.setItem("k", "v")
    await tick(30)
    expect(seen).toEqual([])
  })

  test("the default handler toasts at most once per session, however many writes fail", async () => {
    __resetQuotaToastForTests()
    let shown = 0
    const show = () => {
      shown++
    }
    const s = debouncedStorage({
      target: new FullStorage(new DOMException("full", "QuotaExceededError")),
      delayMs: 5,
      onQuotaExceeded: () => notifyStorageQuotaExceeded(show),
    })
    for (let i = 0; i < 5; i++) {
      s.setItem("k", String(i))
      await tick(15)
    }
    expect(shown).toBe(1)
    expect(notifyStorageQuotaExceeded(show)).toBe(false)
    __resetQuotaToastForTests()
    expect(notifyStorageQuotaExceeded(show)).toBe(true)
    expect(shown).toBe(2)
  })
})
