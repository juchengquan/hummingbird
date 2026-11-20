import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import {
  getLocalDataOwner,
  hasReconciled,
  markReconciled,
  setLocalDataOwner,
} from "./sync-owner"

// bun has no localStorage; install a Map-backed shim for this file only.
const store = new Map<string, string>()
const hadLocalStorage = "localStorage" in globalThis
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

afterAll(() => {
  if (!hadLocalStorage) delete (globalThis as { localStorage?: unknown }).localStorage
})

beforeEach(() => store.clear())

describe("getLocalDataOwner", () => {
  test("unknown on a fresh device", () => {
    expect(getLocalDataOwner()).toBeNull()
  })

  test("explicit owner record wins", () => {
    markReconciled("user-a")
    markReconciled("user-b")
    setLocalDataOwner("user-b")
    expect(getLocalDataOwner()).toBe("user-b")
  })

  test("legacy install: inferred only when exactly one account reconciled here", () => {
    markReconciled("user-a")
    expect(getLocalDataOwner()).toBe("user-a")
    markReconciled("user-b")
    expect(getLocalDataOwner()).toBeNull()
  })

  test("reconciled set round-trips", () => {
    expect(hasReconciled("user-a")).toBe(false)
    markReconciled("user-a")
    expect(hasReconciled("user-a")).toBe(true)
  })
})
