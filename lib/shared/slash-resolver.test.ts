import { describe, expect, test } from "bun:test"
import { matchSlashMenu, resolveSlash } from "./slash-resolver"

describe("resolveSlash", () => {
  test("resolves a skill (trailing space + body)", () => {
    const r = resolveSlash("/search latest news")
    expect(r).toEqual({
      kind: "skill",
      skillId: "webSearch",
      trigger: "search",
      remainder: "latest news",
    })
  })

  test("resolves an instant command (no trailing space)", () => {
    const r = resolveSlash("/clear")
    expect(r).toEqual({
      kind: "command",
      commandId: "clear",
      trigger: "clear",
      arg: "",
    })
  })

  test("resolves an arg command", () => {
    const r = resolveSlash("/rename Trip planning")
    expect(r).toEqual({
      kind: "command",
      commandId: "rename",
      trigger: "rename",
      arg: "Trip planning",
    })
  })

  test("required-arg command with no body → null", () => {
    expect(resolveSlash("/rename")).toBeNull()
  })

  test("plain text → null", () => {
    expect(resolveSlash("hello there")).toBeNull()
    expect(resolveSlash("/unknown thing")).toBeNull()
  })

  test("skill takes its space-delimited form; command its bare form — no overlap", () => {
    // `/search` bare (no space) is NOT a skill (skills need a body) and
    // NOT a command (no `search` command) → null, treated as typing.
    expect(resolveSlash("/search")).toBeNull()
  })
})

describe("resolveSlash — task modes", () => {
  test("resolves /research <goal>", () => {
    const r = resolveSlash("/research compare React 19 vs Vue 4")
    expect(r).toEqual({
      kind: "task_mode",
      modeId: "research",
      trigger: "research",
      goal: "compare React 19 vs Vue 4",
    })
  })

  test("/research alone → null (still typing)", () => {
    expect(resolveSlash("/research")).toBeNull()
  })

  test("/research with empty body → null", () => {
    expect(resolveSlash("/research   ")).toBeNull()
  })

  test("task mode takes precedence over skill on the same trigger", () => {
    // No skill named `research` today, but if one were ever added the
    // resolver still returns the task mode first.
    const r = resolveSlash("/research x")
    expect(r?.kind).toBe("task_mode")
  })
})

describe("matchSlashMenu", () => {
  test("empty partial lists modes, then commands, then skills", () => {
    const all = matchSlashMenu("")
    const firstSkillIdx = all.findIndex((e) => e.kind === "skill")
    const lastCommandIdx =
      all.length - 1 - [...all].reverse().findIndex((e) => e.kind === "command")
    const lastModeIdx =
      all.length - 1 - [...all].reverse().findIndex((e) => e.kind === "task_mode")
    expect(lastModeIdx).toBeLessThan(lastCommandIdx)
    expect(lastCommandIdx).toBeLessThan(firstSkillIdx)
    expect(all.some((e) => e.group === "Commands")).toBe(true)
    expect(all.some((e) => e.group === "Skills")).toBe(true)
    expect(all.some((e) => e.group === "Modes")).toBe(true)
  })

  test("partial filters across all kinds", () => {
    // "s" prefixes s-skills (search/…) AND the `skills` command — a
    // genuine cross-kind partial.
    const s = matchSlashMenu("s")
    expect(s.some((e) => e.kind === "skill")).toBe(true)
    expect(s.some((e) => e.kind === "command" && e.id === "skills")).toBe(true)
    // "cl" prefixes the clear command only.
    const cl = matchSlashMenu("cl")
    expect(cl).toHaveLength(1)
    expect(cl[0]).toMatchObject({ kind: "command", id: "clear" })
    // "res" prefixes the `research` task mode only.
    const res = matchSlashMenu("res")
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ kind: "task_mode", id: "research" })
  })

  test("command entries carry argKind; skill + task_mode entries don't", () => {
    const rename = matchSlashMenu("rename")[0]
    expect(rename.kind).toBe("command")
    expect(rename.argKind).toBe("required")
    const search = matchSlashMenu("search")[0]
    expect(search.kind).toBe("skill")
    expect(search.argKind).toBeUndefined()
    const research = matchSlashMenu("research")[0]
    expect(research.kind).toBe("task_mode")
    expect(research.argKind).toBeUndefined()
  })
})
