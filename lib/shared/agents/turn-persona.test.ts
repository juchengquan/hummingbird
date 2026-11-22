import { describe, expect, test } from "bun:test"

import type { Agent, Message } from "../types"
import { latestTurnPersona, parseTurnPersona, recordTurnPersona, resolveTurnPersona } from "./turn-persona"

const agent: Agent = {
  id: "a1",
  workspaceId: "w1",
  name: "Reviewer",
  slug: "reviewer",
  systemPrompt: "Review.",
  modelId: "anthropic/claude-haiku-4.5",
  allowedSkillIds: ["searchFiles"],
  allowedMcpServerIds: ["x", "y"],
  createdAt: new Date(0),
  updatedAt: new Date(0),
}
const recorded = (...ids: string[]) => ({ agentId: "a1", allowedMcpServerIds: ids })

describe("resolveTurnPersona", () => {
  test("no record → no persona, no restriction", () => {
    expect(resolveTurnPersona(undefined, [agent])).toEqual({
      systemPrompt: "",
      forcedSkillIds: [],
      allowedMcpServerIds: null,
    })
  })

  test("the persona as it is now gives prompt, model and skills", () => {
    expect(resolveTurnPersona(recordTurnPersona(agent), [agent])).toEqual({
      systemPrompt: "Review.",
      modelId: "anthropic/claude-haiku-4.5",
      forcedSkillIds: ["searchFiles"],
      allowedMcpServerIds: ["x", "y"],
    })
  })

  test("the saved list is a ceiling: a widened persona adds nothing", () => {
    expect(resolveTurnPersona(recorded("x"), [agent]).allowedMcpServerIds).toEqual(["x"])
    expect(resolveTurnPersona(recorded(), [agent]).allowedMcpServerIds).toEqual([])
  })

  test("a narrowed persona narrows", () => {
    const narrowed = { ...agent, allowedMcpServerIds: ["y"] }
    expect(resolveTurnPersona(recorded("x", "y"), [narrowed]).allowedMcpServerIds).toEqual(["y"])
  })

  test.each([[[]], [[{ ...agent, deletedAt: new Date() }]]])(
    "a persona that is missing or deleted leaves its list in force",
    (agents: Agent[]) => {
      expect(resolveTurnPersona(recorded("x"), agents)).toEqual({
        systemPrompt: "",
        forcedSkillIds: [],
        allowedMcpServerIds: ["x"],
      })
    },
  )
})

describe("latestTurnPersona", () => {
  const msg = (role: Message["role"], turnPersona?: Message["turnPersona"]): Message => ({
    id: crypto.randomUUID(),
    role,
    content: "m",
    timestamp: new Date(0),
    turnPersona,
  })

  test("the newest user message decides", () => {
    expect(latestTurnPersona([msg("user"), msg("user", recorded()), msg("assistant")])).toEqual(recorded())
    expect(latestTurnPersona([msg("user", recorded()), msg("user")])).toBeUndefined()
  })
})

describe("parseTurnPersona", () => {
  test("absent → none; valid → kept", () => {
    expect(parseTurnPersona(null)).toBeUndefined()
    expect(parseTurnPersona(undefined)).toBeUndefined()
    expect(parseTurnPersona(recorded("x"))).toEqual(recorded("x"))
  })

  test.each([["nope"], [{ agentId: "a1" }], [{ agentId: "a1", allowedMcpServerIds: [1] }]])(
    "unreadable %j fails closed",
    (raw: unknown) => {
      expect(parseTurnPersona(raw)?.allowedMcpServerIds).toEqual([])
    },
  )
})
