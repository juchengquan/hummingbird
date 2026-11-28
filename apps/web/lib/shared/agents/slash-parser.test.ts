import { describe, expect, test } from "bun:test"

import type { Agent } from "../types"
import { matchAgentSlugs, parseAgentSlash } from "./slash-parser"

const make = (slug: string, name = slug, deleted = false): Agent => ({
  id: `id-${slug}`,
  workspaceId: "w1",
  name,
  slug,
  systemPrompt: "",
  allowedSkillIds: [],
  allowedMcpServerIds: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...(deleted ? { deletedAt: new Date(1) } : {}),
})

const agents: Agent[] = [
  make("code-reviewer", "Code reviewer"),
  make("writer", "Long-form writer"),
  make("old", "Old persona", true),
]

describe("parseAgentSlash", () => {
  test("parses `/<slug> body`", () => {
    const r = parseAgentSlash("/code-reviewer review this diff", agents)
    expect(r).not.toBeNull()
    expect(r?.agent.slug).toBe("code-reviewer")
    expect(r?.trigger).toBe("code-reviewer")
    expect(r?.remainder).toBe("review this diff")
  })

  test("case-insensitive on the slug", () => {
    const r = parseAgentSlash("/CODE-REVIEWER x", agents)
    expect(r?.agent.slug).toBe("code-reviewer")
  })

  test("returns null on `/<slug>` alone (still typing)", () => {
    expect(parseAgentSlash("/code-reviewer", agents)).toBeNull()
  })

  test("body may be empty after the trailing space", () => {
    expect(parseAgentSlash("/writer ", agents)?.remainder).toBe("")
  })

  test("ignores soft-deleted personas", () => {
    expect(parseAgentSlash("/old hello", agents)).toBeNull()
  })

  test("returns null for unknown slug", () => {
    expect(parseAgentSlash("/unknown body", agents)).toBeNull()
  })

  test("returns null on leading whitespace", () => {
    expect(parseAgentSlash("  /writer hello", agents)).toBeNull()
  })
})

describe("matchAgentSlugs", () => {
  test("empty partial returns all active personas", () => {
    const r = matchAgentSlugs("", agents)
    expect(r).toHaveLength(2)
    expect(r.map((a) => a.slug)).toEqual(["code-reviewer", "writer"])
  })

  test("prefix-matches on slug", () => {
    expect(matchAgentSlugs("co", agents).map((a) => a.slug)).toEqual([
      "code-reviewer",
    ])
    expect(matchAgentSlugs("xyz", agents)).toHaveLength(0)
  })

  test("never returns deleted personas", () => {
    const r = matchAgentSlugs("ol", agents)
    expect(r).toHaveLength(0)
  })
})
