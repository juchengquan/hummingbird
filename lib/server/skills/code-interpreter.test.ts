import { describe, expect, test } from "bun:test"

import { codeInterpreterSkill } from "./code-interpreter"

const origUrl = process.env.CODE_SANDBOX_BASE_URL

describe("codeInterpreterSkill", () => {
  test("identity", () => {
    expect(codeInterpreterSkill.id).toBe("codeInterpreter")
    expect(codeInterpreterSkill.toolName).toBe("runCode")
  })
  test("buildTool returns null when no sandbox configured (gate)", () => {
    delete process.env.CODE_SANDBOX_BASE_URL
    expect(codeInterpreterSkill.buildTool(undefined, {})).toBeNull()
    if (origUrl !== undefined) process.env.CODE_SANDBOX_BASE_URL = origUrl
  })
  test("buildTool returns a tool when configured", () => {
    process.env.CODE_SANDBOX_BASE_URL = "http://localhost:5555"
    const t = codeInterpreterSkill.buildTool(undefined, {})
    expect(t).not.toBeNull()
    if (origUrl === undefined) delete process.env.CODE_SANDBOX_BASE_URL
    else process.env.CODE_SANDBOX_BASE_URL = origUrl
  })
  test("promptFragment mentions runCode + savefig + no network", () => {
    const p = codeInterpreterSkill.promptFragment(undefined) ?? ""
    expect(p).toContain("runCode")
    expect(p.toLowerCase()).toContain("savefig")
    expect(p.toLowerCase()).toContain("no network")
  })
})
