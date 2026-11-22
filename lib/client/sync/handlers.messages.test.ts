import { describe, expect, test } from "bun:test"

import type { Message } from "@/shared/types"

import { diffConversationMessages } from "./handlers"

const msg = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  role: "user",
  content: "hi",
  timestamp: new Date("2026-05-23T00:00:00Z"),
  ...over,
})

describe("diffConversationMessages — turn persona (Q52)", () => {
  const turnPersona = { agentId: "a1", allowedMcpServerIds: [] }

  test("the record is uploaded, [] included", () => {
    const [op] = diffConversationMessages("c1", [], [msg({ turnPersona })])
    expect(op.kind === "upsert" && op.row.turn_persona).toEqual(turnPersona)
  })

  test("no record → no column, so it never clears one and needs no 0044", () => {
    const [op] = diffConversationMessages("c1", [], [msg()])
    expect(op.kind === "upsert" && "turn_persona" in op.row).toBe(false)
  })

  test("an equal record is not an edit; a new one is", () => {
    expect(diffConversationMessages("c1", [msg({ turnPersona })], [msg({ turnPersona: { ...turnPersona } })])).toEqual([])
    expect(diffConversationMessages("c1", [msg()], [msg({ turnPersona })])).toHaveLength(1)
  })
})
