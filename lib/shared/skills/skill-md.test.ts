import { describe, expect, test } from "bun:test"

import { parseSkillMd, toSkillMd } from "./skill-md"

describe("parseSkillMd", () => {
  test("parses front-matter + body", () => {
    const md = `---
name: Code Reviewer
description: Reviews diffs
when_to_use: When a diff is shared
---
You are a meticulous reviewer.
Be terse.`
    const out = parseSkillMd(md)
    expect(out).toEqual({
      name: "Code Reviewer",
      description: "Reviews diffs",
      whenToUse: "When a diff is shared",
      body: "You are a meticulous reviewer.\nBe terse.",
    })
  })

  test("accepts the when-to-use hyphen variant + optional fields", () => {
    const md = `---
name: Minimal
when-to-use: anytime
---
body here`
    const out = parseSkillMd(md)
    expect(out).toMatchObject({
      name: "Minimal",
      description: "",
      whenToUse: "anytime",
      body: "body here",
    })
  })

  test("missing front-matter → error", () => {
    expect(parseSkillMd("just a body, no fence")).toEqual({
      error: expect.stringContaining("front-matter"),
    })
  })

  test("front-matter without a name → error", () => {
    const md = `---
description: no name here
---
body`
    expect(parseSkillMd(md)).toEqual({
      error: expect.stringContaining("name"),
    })
  })

  test("empty body is allowed", () => {
    const md = `---
name: Just Instructions
---
`
    expect(parseSkillMd(md)).toMatchObject({ name: "Just Instructions", body: "" })
  })
})

describe("toSkillMd / round-trip", () => {
  test("round-trips a full skill", () => {
    const skill = {
      name: "Reviewer",
      description: "Reviews diffs",
      whenToUse: "on diffs",
      body: "Be terse.\nUse bullet points.",
    }
    const reparsed = parseSkillMd(toSkillMd(skill))
    expect(reparsed).toEqual(skill)
  })

  test("omits empty optional front-matter lines", () => {
    const md = toSkillMd({ name: "Bare", description: "", whenToUse: "", body: "hi" })
    expect(md).not.toContain("description:")
    expect(md).not.toContain("when_to_use:")
    expect(parseSkillMd(md)).toMatchObject({ name: "Bare", body: "hi" })
  })
})
