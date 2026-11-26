/** Wave 11 (Q110 / Q111): the deploy default and the sign-in rule. */
import { describe, expect, test } from "bun:test"

import { defaultChatBackend, isChatBackend, reconcileChatBackend } from "./chat-backend"

describe("defaultChatBackend", () => {
  test("agent-py (runs) when agent-py is configured, else the Next.js route", () => {
    expect(defaultChatBackend(true)).toBe("python-runs")
    expect(defaultChatBackend(false)).toBe("ts")
  })

  test("the four values", () => {
    for (const v of ["ts", "python", "ts-service", "python-runs"]) expect(isChatBackend(v)).toBe(true)
    for (const v of [null, undefined, "", "rust", 1]) expect(isChatBackend(v)).toBe(false)
  })
})

describe("reconcileChatBackend on sign-in", () => {
  test("a set account value wins, and isn't written back", () => {
    expect(reconcileChatBackend({ server: "ts", local: "python-runs", localExplicit: true })).toEqual({ apply: "ts" })
    expect(reconcileChatBackend({ server: "ts", local: "python-runs", localExplicit: false })).toEqual({ apply: "ts" })
  })

  test("the same value: nothing to do", () => {
    expect(reconcileChatBackend({ server: "python", local: "python", localExplicit: true })).toEqual({})
  })

  test("an unset account takes the browser's explicit choice", () => {
    expect(reconcileChatBackend({ server: null, local: "ts", localExplicit: true })).toEqual({ push: "ts" })
  })

  test("unset on both sides: the default stays, nothing is written", () => {
    expect(reconcileChatBackend({ server: null, local: "python-runs", localExplicit: false })).toEqual({})
  })
})
