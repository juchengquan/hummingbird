import { describe, expect, test } from "bun:test"

import { buildTaskSystemPrompt } from "./task-prompt"

describe("buildTaskSystemPrompt — default mode", () => {
  test("includes the default loop instructions", () => {
    const p = buildTaskSystemPrompt({
      enabledSkillIds: [],
      skillRequestEntries: [],
    })
    expect(p).toContain("autonomous agent")
    expect(p).toContain("setPlan")
    expect(p).toContain("clear final answer in Markdown")
    expect(p).not.toContain("research agent")
  })

  test("undefined mode is treated as default", () => {
    const a = buildTaskSystemPrompt({
      enabledSkillIds: [],
      skillRequestEntries: [],
      mode: undefined,
    })
    const b = buildTaskSystemPrompt({
      enabledSkillIds: [],
      skillRequestEntries: [],
      mode: "default",
    })
    expect(a).toBe(b)
  })

  test("workspace prompt + skill notes are prepended/appended", () => {
    const p = buildTaskSystemPrompt({
      workspaceSystemPrompt: "  Be concise.  ",
      enabledSkillIds: [],
      skillRequestEntries: [],
    })
    // workspace prompt was trimmed and prepended.
    expect(p.startsWith("Be concise.")).toBe(true)
  })
})

describe("buildTaskSystemPrompt — research mode", () => {
  test("replaces the default loop with the research workflow", () => {
    const p = buildTaskSystemPrompt({
      enabledSkillIds: [],
      skillRequestEntries: [],
      mode: "research",
    })
    expect(p).toContain("research agent")
    expect(p).toContain("structured, cited Markdown report")
    expect(p).toContain("Plan.")
    expect(p).toContain("Research each sub-question")
    expect(p).toContain("Gap pass")
    expect(p).toContain("Synthesize")
    expect(p).toContain("## Sources")
    // Default loop instructions should not bleed through.
    expect(p).not.toContain("autonomous agent inside the Hummingbird app")
  })

  test("workspace prompt is still prepended in research mode", () => {
    const p = buildTaskSystemPrompt({
      workspaceSystemPrompt: "Custom workspace voice.",
      enabledSkillIds: [],
      skillRequestEntries: [],
      mode: "research",
    })
    expect(p.startsWith("Custom workspace voice.")).toBe(true)
    expect(p).toContain("research agent")
  })
})
