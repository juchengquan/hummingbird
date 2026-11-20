import { describe, expect, test } from "bun:test"

import { extractPersistedTheme } from "./persisted-theme"

const blob = (state: Record<string, unknown>) =>
  JSON.stringify({ state, version: 31 })

describe("extractPersistedTheme", () => {
  test("reads the leading theme key the store writes", () => {
    expect(extractPersistedTheme(blob({ theme: "light", conversations: [] }))).toBe(
      "light"
    )
    expect(extractPersistedTheme(blob({ theme: "system" }))).toBe("system")
  })

  test("falls back to the first unescaped occurrence when not leading", () => {
    expect(extractPersistedTheme(blob({ colorScheme: "x", theme: "dark" }))).toBe(
      "dark"
    )
  })

  test("never matches theme-like text inside a string value", () => {
    const raw = blob({
      notes: [{ id: "n", body: '{"theme":"light"}' }],
    })
    expect(extractPersistedTheme(raw)).toBeNull()
  })

  test("rejects unknown values and empty input", () => {
    expect(extractPersistedTheme(blob({ theme: "neon" }))).toBeNull()
    expect(extractPersistedTheme(null)).toBeNull()
    expect(extractPersistedTheme("")).toBeNull()
    expect(extractPersistedTheme("{corrupt")).toBeNull()
  })
})
