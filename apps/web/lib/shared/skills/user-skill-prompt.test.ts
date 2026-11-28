import { describe, expect, test } from "bun:test"

import {
  composeUserSkillInstructions,
  withUserSkillInstructions,
} from "./user-skill-prompt"
import type { UserSkill } from "./user-skill-types"

let seq = 0
function skill(p: Partial<UserSkill>): UserSkill {
  seq += 1
  return {
    id: `s${seq}`,
    workspaceId: "ws1",
    name: `Skill ${seq}`,
    description: "",
    whenToUse: "",
    body: "do the thing",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...p,
  }
}

describe("composeUserSkillInstructions", () => {
  test("joins enabled, non-deleted, workspace-matching skills", () => {
    const out = composeUserSkillInstructions(
      [
        skill({ name: "A", body: "alpha" }),
        skill({ name: "B", body: "beta" }),
      ],
      "ws1"
    )
    expect(out).toBe("## Active skills\n\n### A\nalpha\n\n### B\nbeta")
  })

  test("filters disabled / deleted / other-workspace / empty-body", () => {
    const out = composeUserSkillInstructions(
      [
        skill({ name: "Off", enabled: false }),
        skill({ name: "Gone", deletedAt: new Date() }),
        skill({ name: "Other", workspaceId: "ws2" }),
        skill({ name: "Blank", body: "   " }),
        skill({ name: "Keep", body: "kept" }),
      ],
      "ws1"
    )
    expect(out).toBe("## Active skills\n\n### Keep\nkept")
  })

  test("no active skills → undefined", () => {
    expect(composeUserSkillInstructions([], "ws1")).toBeUndefined()
    expect(
      composeUserSkillInstructions([skill({ enabled: false })], "ws1")
    ).toBeUndefined()
  })

  test("no workspace id → undefined", () => {
    expect(composeUserSkillInstructions([skill({})], null)).toBeUndefined()
  })
})

describe("withUserSkillInstructions", () => {
  test("appends the skill block after the base prompt", () => {
    const out = withUserSkillInstructions(
      "You are helpful.",
      [skill({ name: "A", body: "alpha" })],
      "ws1"
    )
    expect(out).toBe("You are helpful.\n\n## Active skills\n\n### A\nalpha")
  })

  test("returns the base unchanged when no skills are active", () => {
    expect(withUserSkillInstructions("base", [], "ws1")).toBe("base")
  })

  test("returns just the block when base is empty", () => {
    expect(
      withUserSkillInstructions(undefined, [skill({ name: "A", body: "a" })], "ws1")
    ).toBe("## Active skills\n\n### A\na")
  })

  test("both empty → undefined", () => {
    expect(withUserSkillInstructions(undefined, [], "ws1")).toBeUndefined()
  })
})
