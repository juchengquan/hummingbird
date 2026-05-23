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

describe("matchSlashMenu", () => {
  test("empty partial lists commands first, then skills", () => {
    const all = matchSlashMenu("")
    const firstSkillIdx = all.findIndex((e) => e.kind === "skill")
    const lastCommandIdx =
      all.length - 1 - [...all].reverse().findIndex((e) => e.kind === "command")
    expect(lastCommandIdx).toBeLessThan(firstSkillIdx)
    expect(all.some((e) => e.group === "Commands")).toBe(true)
    expect(all.some((e) => e.group === "Skills")).toBe(true)
  })

  test("partial filters across both kinds", () => {
    // "s" prefixes the `search`/`s` skill but no command.
    const s = matchSlashMenu("s")
    expect(s.every((e) => e.kind === "skill")).toBe(true)
    // "cl" prefixes the clear command only.
    const cl = matchSlashMenu("cl")
    expect(cl).toHaveLength(1)
    expect(cl[0]).toMatchObject({ kind: "command", id: "clear" })
  })

  test("command entries carry argKind; skill entries don't", () => {
    const rename = matchSlashMenu("rename")[0]
    expect(rename.kind).toBe("command")
    expect(rename.argKind).toBe("required")
    const search = matchSlashMenu("search")[0]
    expect(search.kind).toBe("skill")
    expect(search.argKind).toBeUndefined()
  })
})
