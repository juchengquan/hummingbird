import { describe, expect, test as it } from "bun:test"

import { listCommandTriggers } from "../commands/registry"
import { listSlashTriggers } from "../skills/slash-parser"

import {
  TASK_MODES,
  listTaskModeTriggers,
  matchTaskModeTriggers,
  parseTaskModeCommand,
} from "./registry"

describe("parseTaskModeCommand", () => {
  it("parses `/research <goal>`", () => {
    const r = parseTaskModeCommand("/research compare React 19 vs Vue 4")
    expect(r).not.toBeNull()
    expect(r?.modeId).toBe("research")
    expect(r?.trigger).toBe("research")
    expect(r?.goal).toBe("compare React 19 vs Vue 4")
  })

  it("is case-insensitive on the trigger", () => {
    const r = parseTaskModeCommand("/RESEARCH x")
    expect(r?.modeId).toBe("research")
  })

  it("returns null on `/research` alone (still typing)", () => {
    expect(parseTaskModeCommand("/research")).toBeNull()
  })

  it("returns null on `/research ` with an empty body", () => {
    expect(parseTaskModeCommand("/research   ")).toBeNull()
  })

  it("returns null on unrelated text", () => {
    expect(parseTaskModeCommand("research x")).toBeNull()
    expect(parseTaskModeCommand("/searchx hi")).toBeNull()
  })

  it("returns null on leading whitespace", () => {
    expect(parseTaskModeCommand("  /research x")).toBeNull()
  })

  it("trims the goal", () => {
    expect(parseTaskModeCommand("/research   hello world  ")?.goal).toBe(
      "hello world"
    )
  })
})

describe("matchTaskModeTriggers", () => {
  it("returns every entry on empty partial", () => {
    expect(matchTaskModeTriggers("").length).toBe(TASK_MODES.length)
  })

  it("prefix-matches", () => {
    expect(matchTaskModeTriggers("res").map((e) => e.mode.id)).toEqual([
      "research",
    ])
    expect(matchTaskModeTriggers("xyz").length).toBe(0)
  })
})

describe("listTaskModeTriggers", () => {
  it("includes research with the canonical trigger", () => {
    const list = listTaskModeTriggers()
    const research = list.find((e) => e.mode.id === "research")
    expect(research).toBeDefined()
    expect(research?.trigger).toBe("research")
    expect(research?.aliases).toContain("research")
  })

  it("research forces webSearch + webFetch + searchFiles", () => {
    const research = TASK_MODES.find((m) => m.id === "research")
    expect(research?.forcedSkillIds).toContain("webSearch")
    expect(research?.forcedSkillIds).toContain("webFetch")
    expect(research?.forcedSkillIds).toContain("searchFiles")
  })
})

describe("task-mode registry integrity", () => {
  it("every task-mode trigger + alias is unique within the registry", () => {
    const seen = new Set<string>()
    for (const e of listTaskModeTriggers()) {
      for (const a of e.aliases) {
        const key = a.toLowerCase()
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
  })

  it("no task-mode trigger collides with a skill or command trigger", () => {
    const taken = new Set<string>()
    for (const s of listSlashTriggers()) {
      for (const a of s.aliases) taken.add(a.toLowerCase())
    }
    for (const c of listCommandTriggers()) {
      for (const a of c.aliases) taken.add(a.toLowerCase())
    }
    for (const e of listTaskModeTriggers()) {
      for (const a of e.aliases) {
        expect(taken.has(a.toLowerCase())).toBe(false)
      }
    }
  })
})
