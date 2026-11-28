import { describe, expect, test } from "bun:test"

import type { Agent } from "../types"
import {
  decodeAgentShareToken,
  encodeAgentShareToken,
  toShareable,
} from "./share"

const sample: Agent = {
  id: "id-1",
  workspaceId: "w1",
  name: "Code reviewer",
  slug: "code-reviewer",
  systemPrompt: "You review pull-request diffs.",
  modelId: "claude-sonnet-4-6",
  allowedSkillIds: ["searchFiles", "webSearch"],
  allowedMcpServerIds: ["github-mcp"],
  icon: "UserCircle",
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

describe("toShareable", () => {
  test("strips id, workspaceId, timestamps, pinned, deletedAt", () => {
    const s = toShareable({
      ...sample,
      pinned: true,
      deletedAt: new Date(1),
    })
    expect(Object.keys(s).sort()).toEqual(
      [
        "allowedMcpServerIds",
        "allowedSkillIds",
        "icon",
        "modelId",
        "name",
        "slug",
        "systemPrompt",
      ].sort()
    )
  })

  test("preserves field values verbatim", () => {
    const s = toShareable(sample)
    expect(s.name).toBe(sample.name)
    expect(s.slug).toBe(sample.slug)
    expect(s.systemPrompt).toBe(sample.systemPrompt)
    expect(s.modelId).toBe(sample.modelId)
    expect(s.allowedSkillIds).toEqual(sample.allowedSkillIds)
    expect(s.allowedMcpServerIds).toEqual(sample.allowedMcpServerIds)
    expect(s.icon).toBe(sample.icon!)
  })

  test("omits modelId/icon when unset", () => {
    const minimal: Agent = {
      ...sample,
      modelId: undefined,
      icon: undefined,
    }
    const s = toShareable(minimal)
    expect("modelId" in s).toBe(false)
    expect("icon" in s).toBe(false)
  })
})

describe("encode + decode roundtrip", () => {
  test("decodes back to an identical shareable", () => {
    const original = toShareable(sample)
    const token = encodeAgentShareToken(original)
    const round = decodeAgentShareToken(token)
    expect(round).toEqual(original)
  })

  test("token is URL-safe (no `+`, `/`, `=`)", () => {
    const token = encodeAgentShareToken(toShareable(sample))
    expect(token).not.toMatch(/[+/=]/)
  })

  test("handles unicode and quote chars in the prompt", () => {
    const a = toShareable({
      ...sample,
      systemPrompt: 'You speak Markdown — and "smart quotes" — 你好 🌱',
    })
    const round = decodeAgentShareToken(encodeAgentShareToken(a))
    expect(round?.systemPrompt).toBe(a.systemPrompt)
  })
})

describe("decodeAgentShareToken — rejects malformed input", () => {
  test("garbage base64 returns null", () => {
    expect(decodeAgentShareToken("!!!notbase64!!!")).toBeNull()
  })

  test("base64 of non-JSON returns null", () => {
    // base64-encoded "not json"
    const token = encodeAgentShareToken({
      name: "x",
      slug: "x",
      systemPrompt: "",
      allowedSkillIds: [],
      allowedMcpServerIds: [],
    })
    // Corrupt the middle.
    const bad = token.slice(0, 4) + "@@@@@" + token.slice(9)
    expect(decodeAgentShareToken(bad)).toBeNull()
  })

  test("missing required field returns null", () => {
    const payload = { name: "x" }
    const json = JSON.stringify(payload)
    const bytes = new TextEncoder().encode(json)
    let bin = ""
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    const token = btoa(bin)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(decodeAgentShareToken(token)).toBeNull()
  })

  test("non-array allowedSkillIds returns null", () => {
    const payload = {
      name: "x",
      slug: "x",
      systemPrompt: "",
      allowedSkillIds: "all",
      allowedMcpServerIds: [],
    }
    const json = JSON.stringify(payload)
    const bytes = new TextEncoder().encode(json)
    let bin = ""
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    const token = btoa(bin)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(decodeAgentShareToken(token)).toBeNull()
  })
})
