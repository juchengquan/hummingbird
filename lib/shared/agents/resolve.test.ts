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

describe("composeSystemPrompts — 3-tier (workspace, conversation, persona)", () => {
  test("all empty → undefined", () => {
    expect(composeSystemPrompts(undefined, undefined, "")).toBeUndefined()
    expect(composeSystemPrompts("  ", "  ", "  ")).toBeUndefined()
  })

  test("workspace-only", () => {
    expect(composeSystemPrompts("Be concise.", undefined, "")).toBe("Be concise.")
  })

  test("conversation-only — used as the voice when no other voice", () => {
    expect(
      composeSystemPrompts(undefined, "We're planning Q4 OKRs.", ""),
    ).toBe("We're planning Q4 OKRs.")
  })

  test("persona-only", () => {
    expect(composeSystemPrompts(undefined, undefined, "You are a critic.")).toBe(
      "You are a critic.",
    )
  })

  test("workspace + conversation: voice + context, blank-line separated", () => {
    expect(
      composeSystemPrompts(
        "Be concise.",
        "We're planning Q4 OKRs.",
        "",
      ),
    ).toBe("Be concise.\n\nWe're planning Q4 OKRs.")
  })

  test("persona REPLACES workspace voice; conversation context survives", () => {
    // The whole point of the additive model: switching personas
    // doesn't blow away "what this thread is about."
    expect(
      composeSystemPrompts(
        "Be concise.",
        "We're planning Q4 OKRs.",
        "You are a critic.",
      ),
    ).toBe("You are a critic.\n\nWe're planning Q4 OKRs.")
  })

  test("persona + conversation, no workspace", () => {
    expect(
      composeSystemPrompts(
        undefined,
        "We're planning Q4 OKRs.",
        "You are a critic.",
      ),
    ).toBe("You are a critic.\n\nWe're planning Q4 OKRs.")
  })

  test("all three inputs are trimmed before joining", () => {
    expect(
      composeSystemPrompts("  Be concise.  ", "  Context.  ", "  "),
    ).toBe("Be concise.\n\nContext.")
  })

  test("empty conversation prompt is a no-op (workspace + persona path unchanged)", () => {
    expect(
      composeSystemPrompts("Be concise.", "", "You are a critic."),
    ).toBe("You are a critic.")
    expect(
      composeSystemPrompts("Be concise.", undefined, "You are a critic."),
    ).toBe("You are a critic.")
  })
})
