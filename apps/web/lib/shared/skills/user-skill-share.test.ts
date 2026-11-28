import { describe, expect, test } from "bun:test"

import {
  decodeSkillShareToken,
  encodeSkillShareToken,
  toShareableUserSkill,
} from "./user-skill-share"
import type { UserSkill } from "./user-skill-types"

const SKILL: UserSkill = {
  id: "abc",
  workspaceId: "ws1",
  name: "Reviewer",
  description: "Reviews diffs",
  whenToUse: "on diffs",
  body: "Be terse. Use bullets.",
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe("user-skill share codec", () => {
  test("toShareableUserSkill strips ids/timestamps/workspace/enabled", () => {
    expect(toShareableUserSkill(SKILL)).toEqual({
      name: "Reviewer",
      description: "Reviews diffs",
      whenToUse: "on diffs",
      body: "Be terse. Use bullets.",
    })
  })

  test("encode → decode round-trips", () => {
    const token = encodeSkillShareToken(toShareableUserSkill(SKILL))
    expect(decodeSkillShareToken(token)).toEqual(toShareableUserSkill(SKILL))
  })

  test("token is URL-safe (base64url, no +/=)", () => {
    const token = encodeSkillShareToken(toShareableUserSkill(SKILL))
    expect(token).not.toMatch(/[+/=]/)
  })

  test("garbage / tampered tokens decode to null", () => {
    expect(decodeSkillShareToken("not-a-real-token!!")).toBeNull()
    expect(decodeSkillShareToken("")).toBeNull()
  })

  test("decoded missing-name → null; missing optionals default to empty", () => {
    const noName = encodeSkillShareToken({
      name: "",
      description: "",
      whenToUse: "",
      body: "x",
    })
    expect(decodeSkillShareToken(noName)).toBeNull()
    const onlyNameBody = encodeSkillShareToken({
      name: "X",
      description: "",
      whenToUse: "",
      body: "b",
    })
    expect(decodeSkillShareToken(onlyNameBody)).toEqual({
      name: "X",
      description: "",
      whenToUse: "",
      body: "b",
    })
  })
})
