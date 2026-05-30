import { describe, expect, test } from "bun:test"

import type { Agent } from "../types"
import { composeSystemPrompts, resolveAgent } from "./resolve"

const sample: Agent = {
  id: "a1",
  workspaceId: "w1",
  name: "Code reviewer",
  slug: "code-reviewer",
  systemPrompt: "You review pull-request diffs.",
  modelId: "claude-sonnet-4-6",
  allowedSkillIds: ["searchFiles"],
  allowedMcpServerIds: ["github-mcp"],
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

describe("resolveAgent", () => {
  test("null persona returns no-op overrides", () => {
    const r = resolveAgent(null)
    expect(r).toEqual({
      systemPrompt: "",
      forcedSkillIds: [],
      allowedMcpServerIds: null,
    })
    expect(r.modelId).toBeUndefined()
  })

  test("deleted persona is treated as null", () => {
    const r = resolveAgent({ ...sample, deletedAt: new Date(1) })
    expect(r.systemPrompt).toBe("")
    expect(r.forcedSkillIds).toEqual([])
  })

  test("active persona maps fields verbatim", () => {
    const r = resolveAgent(sample)
    expect(r.systemPrompt).toBe("You review pull-request diffs.")
    expect(r.modelId).toBe("claude-sonnet-4-6")
    expect(r.forcedSkillIds).toEqual(["searchFiles"])
    expect(r.allowedMcpServerIds).toEqual(["github-mcp"])
  })

  test("empty allowedMcpServerIds is preserved (not collapsed to null)", () => {
    const r = resolveAgent({ ...sample, allowedMcpServerIds: [] })
    expect(r.allowedMcpServerIds).toEqual([])
  })

  test("copies arrays so caller mutations don't leak back into the persona", () => {
    const r = resolveAgent(sample)
    r.forcedSkillIds.push("imageGen")
    expect(sample.allowedSkillIds).toEqual(["searchFiles"])
  })
})

describe("composeSystemPrompts", () => {
  test("undefined + empty → undefined", () => {
    expect(composeSystemPrompts(undefined, "")).toBeUndefined()
    expect(composeSystemPrompts("  ", "  ")).toBeUndefined()
  })

  test("workspace-only", () => {
    expect(composeSystemPrompts("Be concise.", "")).toBe("Be concise.")
  })

  test("persona-only", () => {
    expect(composeSystemPrompts(undefined, "You are a critic.")).toBe(
      "You are a critic."
    )
  })

  test("workspace + persona joined with a blank line", () => {
    expect(composeSystemPrompts("Be concise.", "You are a critic.")).toBe(
      "Be concise.\n\nYou are a critic."
    )
  })

  test("both inputs are trimmed before joining", () => {
    expect(composeSystemPrompts("  Be concise.  ", "  Critic.  ")).toBe(
      "Be concise.\n\nCritic."
    )
  })
})
