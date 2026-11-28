import { describe, expect, test } from "bun:test"

import { latestTaskTurn, resendAs } from "./task-turn"

const user = (taskTurn?: { mode: "default" | "research" }) => ({ role: "user" as const, taskTurn })
const assistant = { role: "assistant" as const }

describe("resending a task turn (bug 4)", () => {
  test("the newest user message decides", () => {
    expect(latestTaskTurn([user({ mode: "research" }), assistant])).toEqual({ mode: "research" })
    expect(latestTaskTurn([user({ mode: "research" }), assistant, user()])).toBeUndefined()
    expect(latestTaskTurn([user(), assistant, user({ mode: "default" })])).toEqual({ mode: "default" })
    expect(latestTaskTurn([assistant])).toBeUndefined()
  })

  test("a task turn resends as a task in its mode; a chat turn as chat", () => {
    expect(resendAs([user({ mode: "research" }), assistant])).toEqual({ asTask: true, taskMode: "research" })
    expect(resendAs([user({ mode: "default" })])).toEqual({ asTask: true, taskMode: "default" })
    expect(resendAs([user(), assistant])).toEqual({})
  })
})
