import { describe, expect, it } from "bun:test"

import { resolveEnabledSkills } from "./resolve-enabled-skills"

describe("resolveEnabledSkills", () => {
  it("returns nothing when no prefs are set (all skills default off)", () => {
    expect(resolveEnabledSkills({})).toEqual([])
    expect(resolveEnabledSkills({ workspace: {} })).toEqual([])
  })

  it("enables skills turned on in the workspace cascade", () => {
    const out = resolveEnabledSkills({
      workspace: { skillPrefs: { webFetch: true } },
    })
    expect(out.map((s) => s.id)).toEqual(["webFetch"])
  })

  it("lets the conversation override the workspace (off beats on)", () => {
    const out = resolveEnabledSkills({
      workspace: { skillPrefs: { webFetch: true } },
      conversation: { skillPrefs: { webFetch: false } },
    })
    expect(out).toEqual([])
  })

  it("lets the conversation enable a skill the workspace left off", () => {
    const out = resolveEnabledSkills({
      workspace: { skillPrefs: { webFetch: false } },
      conversation: { skillPrefs: { webFetch: true } },
    })
    expect(out.map((s) => s.id)).toEqual(["webFetch"])
  })

  it("force-enables a skill even when the cascade has it off", () => {
    const out = resolveEnabledSkills({ forcedSkillIds: ["webFetch"] })
    expect(out.map((s) => s.id)).toEqual(["webFetch"])
  })

  it("mutes a skill, and mute wins over force", () => {
    const out = resolveEnabledSkills({
      workspace: { skillPrefs: { webFetch: true } },
      forcedSkillIds: ["webFetch"],
      mutedSkillIds: ["webFetch"],
    })
    expect(out).toEqual([])
  })

  it("attaches a clamped webSearch config when webSearch is on", () => {
    const out = resolveEnabledSkills({
      workspace: { skillPrefs: { webSearch: true } },
    })
    const ws = out.find((s) => s.id === "webSearch")
    expect(ws?.webSearchConfig).toBeDefined()
    expect(typeof ws?.webSearchConfig?.maxCalls).toBe("number")
    expect(ws?.webSearchConfig?.tavily).toHaveProperty("enabled")
    expect(ws?.webSearchConfig?.brave).toHaveProperty("freshness")
    expect(ws?.webSearchConfig?.exa).toHaveProperty("type")
  })

  it("attaches webFetch and imageGen configs when those are on", () => {
    const out = resolveEnabledSkills({
      workspace: {
        skillPrefs: { webFetch: true, imageGen: true },
      },
    })
    expect(out.find((s) => s.id === "webFetch")?.webFetchConfig).toHaveProperty(
      "maxCalls"
    )
    const img = out.find((s) => s.id === "imageGen")?.imageGenConfig
    expect(img).toHaveProperty("maxCalls")
    expect(img).toHaveProperty("aspectRatio")
  })

  it("does not attach config to a skill that takes none", () => {
    const out = resolveEnabledSkills({
      workspace: { skillPrefs: { searchFiles: true } },
    })
    const sf = out.find((s) => s.id === "searchFiles")
    expect(sf).toEqual({ id: "searchFiles" })
  })
})
