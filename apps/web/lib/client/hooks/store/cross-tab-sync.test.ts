import { describe, expect, test } from "bun:test"

import { decideCrossTabEvent, shouldWriteBack } from "./cross-tab-sync"

const KEY = "hummingbird-storage"
const VERSION = 31
const event = (over: Partial<Parameters<typeof decideCrossTabEvent>[0]> = {}) =>
  decideCrossTabEvent({
    key: KEY,
    newValue: JSON.stringify({ state: { theme: "light" }, version: VERSION }),
    isOwnStorageArea: true,
    hydrated: true,
    storeKey: KEY,
    storeVersion: VERSION,
    ...over,
  })

describe("decideCrossTabEvent", () => {
  test("merges a same-version write to the store key", () => {
    expect(event()).toEqual({ action: "merge", theirs: { theme: "light" } })
  })

  test("ignores other keys, sessionStorage, removals and pre-hydration", () => {
    expect(event({ key: "hummingbird-sync-queue" }).action).toBe("ignore")
    expect(event({ key: null }).action).toBe("ignore")
    expect(event({ isOwnStorageArea: false }).action).toBe("ignore")
    expect(event({ newValue: null }).action).toBe("ignore")
    expect(event({ hydrated: false }).action).toBe("ignore")
  })

  test("ignores a write from a build with another STORE_VERSION", () => {
    const older = JSON.stringify({ state: {}, version: VERSION - 1 })
    const newer = JSON.stringify({ state: {}, version: VERSION + 1 })
    expect(event({ newValue: older })).toEqual({
      action: "ignore",
      reason: "version mismatch",
    })
    expect(event({ newValue: newer }).action).toBe("ignore")
  })

  test("ignores corrupt payloads", () => {
    expect(event({ newValue: "{not json" }).action).toBe("ignore")
    expect(event({ newValue: "null" }).action).toBe("ignore")
    expect(
      event({ newValue: JSON.stringify({ state: [], version: VERSION }) }).action
    ).toBe("ignore")
  })
})

describe("shouldWriteBack", () => {
  test("only when we contributed data or already had a buffered write", () => {
    expect(shouldWriteBack(false, false)).toBe(false)
    expect(shouldWriteBack(true, false)).toBe(true)
    expect(shouldWriteBack(false, true)).toBe(true)
  })
})
