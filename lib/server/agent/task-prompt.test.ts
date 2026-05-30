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

describe("buildTaskSystemPrompt — research mode + searchFiles (Phase 3)", () => {
  test("without searchFiles, step 2b is web-only and uses the web-search wording", () => {
    const p = buildTaskSystemPrompt({
      enabledSkillIds: ["webSearch", "webFetch"],
      skillRequestEntries: [],
      mode: "research",
    })
    expect(p).toContain("Use `webSearch` to find candidate sources")
    // Files-first wording should NOT appear when files aren't enabled.
    expect(p).not.toContain("If any attached file looks relevant")
    expect(p).not.toContain("searchFiles({ fileId, query })")
  })

  test("with searchFiles enabled, step 2b is files-first and the Sources block mentions attached files", () => {
    const p = buildTaskSystemPrompt({
      enabledSkillIds: ["webSearch", "webFetch", "searchFiles"],
      skillRequestEntries: [],
      mode: "research",
    })
    expect(p).toContain("If any attached file looks relevant")
    expect(p).toContain("call `searchFiles({ fileId, query })` first")
    // Both channels are still mentioned for gap-pass and synthesis.
    expect(p).toContain("`webSearch` to find broader candidate sources")
    expect(p).toContain("`[N] file: <name>`")
    expect(p).toContain("(or `searchFiles` against a relevant file)")
  })

  test("default-mode prompt is unaffected by searchFiles being enabled", () => {
    const a = buildTaskSystemPrompt({
      enabledSkillIds: [],
      skillRequestEntries: [],
    })
    const b = buildTaskSystemPrompt({
      enabledSkillIds: ["searchFiles"],
      skillRequestEntries: [],
    })
    // The skills-line note for searchFiles attaches in (b), but the
    // hard-coded loop block stays identical between the two — research-
    // mode files-first branching must not leak into default mode.
    expect(a).toContain("autonomous agent")
    expect(b).toContain("autonomous agent")
    expect(b).not.toContain("If any attached file looks relevant")
  })
})
