import { describe, expect, test } from "bun:test"
import { listSlashTriggers } from "../skills/slash-parser"
import {
  COMMANDS,
  listCommandTriggers,
  matchCommandTriggers,
  parseCommand,
} from "./registry"

describe("command registry integrity", () => {
  test("every command trigger + alias is unique within the registry", () => {
    const seen = new Set<string>()
    for (const e of listCommandTriggers()) {
      for (const a of e.aliases) {
        const key = a.toLowerCase()
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
  })

  test("no command trigger collides with a skill trigger", () => {
    const skillTokens = new Set<string>()
    for (const s of listSlashTriggers()) {
      for (const a of s.aliases) skillTokens.add(a.toLowerCase())
    }
    for (const e of listCommandTriggers()) {
      for (const a of e.aliases) {
        expect(skillTokens.has(a.toLowerCase())).toBe(false)
      }
    }
  })

  test("destructive commands are flagged", () => {
    const clear = COMMANDS.find((c) => c.id === "clear")
    expect(clear?.destructive).toBe(true)
    const rename = COMMANDS.find((c) => c.id === "rename")
    expect(rename?.destructive).toBeFalsy()
  })
})

describe("parseCommand", () => {
  test("instant command, no trailing space", () => {
    const r = parseCommand("/clear")
    expect(r).toEqual({ commandId: "clear", trigger: "clear", arg: "" })
  })

  test("instant command ignores any trailing arg", () => {
    expect(parseCommand("/new")?.commandId).toBe("new")
    expect(parseCommand("/new whatever")?.commandId).toBe("new")
  })

  test("required-arg command with a body", () => {
    const r = parseCommand("/rename My New Title")
    expect(r).toEqual({
      commandId: "rename",
      trigger: "rename",
      arg: "My New Title",
    })
  })

  test("required-arg command with no body → null (still typing)", () => {
    expect(parseCommand("/rename")).toBeNull()
    expect(parseCommand("/rename ")).toBeNull()
  })

  test("optional-arg command works with and without a body", () => {
    expect(parseCommand("/model")?.arg).toBe("")
    expect(parseCommand("/model gpt-4o")?.arg).toBe("gpt-4o")
  })

  test("the /? help alias resolves", () => {
    expect(parseCommand("/?")?.commandId).toBe("help")
    expect(parseCommand("/help")?.commandId).toBe("help")
  })

  test("case-insensitive trigger", () => {
    expect(parseCommand("/CLEAR")?.commandId).toBe("clear")
  })

  test("unknown token → null", () => {
    expect(parseCommand("/bogus")).toBeNull()
    expect(parseCommand("/newsflash")).toBeNull() // not "new"
  })

  test("leading whitespace / non-slash → null", () => {
    expect(parseCommand("  /clear")).toBeNull()
    expect(parseCommand("clear")).toBeNull()
  })
})

describe("matchCommandTriggers", () => {
  test("empty partial returns all commands", () => {
    expect(matchCommandTriggers("").length).toBe(COMMANDS.length)
  })

  test("prefix match", () => {
    expect(matchCommandTriggers("re").map((e) => e.command.id)).toEqual([
      "rename",
    ])
    expect(matchCommandTriggers("zzz")).toEqual([])
  })
})
