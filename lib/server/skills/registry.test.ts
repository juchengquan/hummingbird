import { describe, expect, test } from "bun:test"
import { SERVER_SKILLS } from "./registry"

describe("SERVER_SKILLS — contract per entry", () => {
  test("registry is non-empty (regression guard)", () => {
    expect(SERVER_SKILLS.length).toBeGreaterThan(0)
  })

  test("every entry has the four required fields with sensible types", () => {
    for (const skill of SERVER_SKILLS) {
      expect(typeof skill.id).toBe("string")
      expect(skill.id.length).toBeGreaterThan(0)
      expect(typeof skill.toolName).toBe("string")
      expect(skill.toolName.length).toBeGreaterThan(0)
      expect(typeof skill.buildTool).toBe("function")
      expect(typeof skill.promptFragment).toBe("function")
    }
  })

  test("ids are unique across the registry", () => {
    const ids = SERVER_SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("tool names are unique (so two skills can't collide on registration)", () => {
    const names = SERVER_SKILLS.map((s) => s.toolName)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("webSearch + webFetch are registered", () => {
  test("webSearch is in the registry", () => {
    expect(SERVER_SKILLS.some((s) => s.id === "webSearch")).toBe(true)
  })
  test("webFetch is in the registry", () => {
    expect(SERVER_SKILLS.some((s) => s.id === "webFetch")).toBe(true)
  })
})

describe("codeInterpreter is registered", () => {
  test("includes codeInterpreter after searchFiles", () => {
    const ids = SERVER_SKILLS.map((s) => s.id)
    expect(ids).toContain("codeInterpreter")
    expect(ids.indexOf("codeInterpreter")).toBeGreaterThan(
      ids.indexOf("searchFiles")
    )
  })
})

describe("promptFragment shape", () => {
  test("webFetch.promptFragment returns a non-empty note for any request entry", () => {
    const skill = SERVER_SKILLS.find((s) => s.id === "webFetch")!
    const note = skill.promptFragment(undefined)
    expect(typeof note).toBe("string")
    expect(note!.length).toBeGreaterThan(0)
    // Mirrors the runtime cap exactly — the default flows through.
    expect(note).toContain("HARD LIMIT")
  })

  test("webFetch.promptFragment reflects a custom cap on the request entry", () => {
    const skill = SERVER_SKILLS.find((s) => s.id === "webFetch")!
    const note = skill.promptFragment({
      id: "webFetch",
      webFetchConfig: { maxCalls: 12 },
    })
    expect(note).toContain("12 calls")
  })

  test("webSearch.promptFragment without provider keys still returns something", () => {
    // With no provider env vars set in the test process, the resolver
    // falls back to the "all providers off" branch and the fragment
    // tells the model to say so.
    const skill = SERVER_SKILLS.find((s) => s.id === "webSearch")!
    const note = skill.promptFragment(undefined)
    expect(typeof note).toBe("string")
    expect(note!.length).toBeGreaterThan(0)
  })
})

describe("buildTool shape", () => {
  test("webFetch.buildTool returns a callable tool", () => {
    const skill = SERVER_SKILLS.find((s) => s.id === "webFetch")!
    const tool = skill.buildTool(undefined, {})
    expect(tool).not.toBeNull()
  })

  test("webSearch.buildTool returns null when no provider is configured", () => {
    // No TAVILY/BRAVE/EXA env vars in the test process → buildTool
    // should refuse to register the tool. The prompt fragment still
    // tells the model to say it can't search.
    const skill = SERVER_SKILLS.find((s) => s.id === "webSearch")!
    const tool = skill.buildTool(undefined, {})
    expect(tool).toBeNull()
  })
})
