import { describe, expect, test } from "bun:test"
import {
  isTypingSlashCommand,
  listSlashTriggers,
  matchSlashTriggers,
  parseSlashCommand,
} from "./slash-parser"

describe("listSlashTriggers", () => {
  test("includes the registered skills with canonical-first triggers", () => {
    const entries = listSlashTriggers()
    const byId = Object.fromEntries(entries.map((e) => [e.skillId, e]))
    expect(byId.webSearch?.trigger).toBe("search")
    expect(byId.webFetch?.trigger).toBe("fetch")
    expect(byId.imageGen?.trigger).toBe("image")
    expect(byId.searchFiles?.trigger).toBe("files")
  })

  test("no trigger/alias collides across the registry", () => {
    const seen = new Set<string>()
    for (const e of listSlashTriggers()) {
      for (const a of e.aliases) {
        const key = a.toLowerCase()
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
  })
})

describe("parseSlashCommand", () => {
  test("matches a canonical trigger and strips the prefix", () => {
    const r = parseSlashCommand("/search latest AI news")
    expect(r).not.toBeNull()
    expect(r!.skillId).toBe("webSearch")
    expect(r!.trigger).toBe("search")
    expect(r!.remainder).toBe("latest AI news")
  })

  test("matches an alias", () => {
    expect(parseSlashCommand("/s find X")?.skillId).toBe("webSearch")
    expect(parseSlashCommand("/f read this")?.skillId).toBe("webFetch")
    expect(parseSlashCommand("/img a cat")?.skillId).toBe("imageGen")
    expect(parseSlashCommand("/file the spec")?.skillId).toBe("searchFiles")
  })

  test("is case-insensitive on the trigger", () => {
    const r = parseSlashCommand("/SEARCH hello")
    expect(r?.skillId).toBe("webSearch")
    expect(r?.trigger).toBe("search")
  })

  test("preserves multi-word and inner whitespace in the remainder", () => {
    const r = parseSlashCommand("/search  two  spaces  here ")
    // Leading whitespace after the trigger is consumed/trimmed; inner
    // spacing of the body is preserved; trailing trimmed by trimStart
    // only on the left — trailing stays.
    expect(r!.remainder).toBe("two  spaces  here ")
  })

  test("returns null when there's no trailing whitespace (typo guard)", () => {
    expect(parseSlashCommand("/searchy")).toBeNull()
    expect(parseSlashCommand("/search")).toBeNull()
  })

  test("returns null on leading whitespace (must be first char)", () => {
    expect(parseSlashCommand("  /search x")).toBeNull()
    expect(parseSlashCommand("hi /search x")).toBeNull()
  })

  test("returns null for an unknown trigger", () => {
    expect(parseSlashCommand("/bogus do a thing")).toBeNull()
  })

  test("allows an empty body (trigger + space only)", () => {
    const r = parseSlashCommand("/search ")
    expect(r).not.toBeNull()
    expect(r!.remainder).toBe("")
  })
})

describe("isTypingSlashCommand", () => {
  test("true while typing the token, false once a space appears", () => {
    expect(isTypingSlashCommand("/")).toBe(true)
    expect(isTypingSlashCommand("/sea")).toBe(true)
    expect(isTypingSlashCommand("/search ")).toBe(false)
    expect(isTypingSlashCommand("hello")).toBe(false)
    expect(isTypingSlashCommand("")).toBe(false)
  })
})

describe("matchSlashTriggers", () => {
  test("empty partial returns everything", () => {
    expect(matchSlashTriggers("").length).toBe(listSlashTriggers().length)
  })

  test("prefix-matches canonical and alias", () => {
    const sea = matchSlashTriggers("sea")
    expect(sea.map((e) => e.skillId)).toContain("webSearch")
    // "f" is an alias of webFetch and the prefix of "files" → both match.
    const f = matchSlashTriggers("f").map((e) => e.skillId)
    expect(f).toContain("webFetch")
    expect(f).toContain("searchFiles")
  })

  test("no match → empty list", () => {
    expect(matchSlashTriggers("zzz")).toEqual([])
  })
})
