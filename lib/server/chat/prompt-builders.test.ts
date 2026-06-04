/**
 * Tests for the system-prompt builders previously buried inline in
 * `app/api/chat/route.ts`. Pure functions — no fetch, no streamText,
 * no Anthropic SDK — so the test surface is small and stable.
 */

import { describe, expect, test } from "bun:test"

import {
  buildMcpNote,
  buildRemixNote,
  buildSystemPrompt,
  lastUserText,
} from "./prompt-builders"
import type { SkillId } from "@/shared/skills/types"

describe("buildMcpNote", () => {
  test("returns null when no server has any tool", () => {
    expect(buildMcpNote([])).toBeNull()
    expect(
      buildMcpNote([
        { name: "a", toolCount: 0 },
        { name: "b", toolCount: 0 },
      ]),
    ).toBeNull()
  })

  test("lists active servers with tool counts; skips zero-tool servers", () => {
    const out = buildMcpNote([
      { name: "github", toolCount: 5 },
      { name: "linear", toolCount: 1 },
      { name: "dormant", toolCount: 0 },
    ])
    expect(out).not.toBeNull()
    const text = out!
    expect(text).toContain('"github" (5 tools)')
    expect(text).toContain('"linear" (1 tool)')
    expect(text).not.toContain("dormant")
  })

  test("pluralises 1 tool → 'tool' (singular)", () => {
    const out = buildMcpNote([{ name: "x", toolCount: 1 }])
    expect(out).toContain("(1 tool)")
    expect(out).not.toContain("(1 tools)")
  })
})

describe("buildRemixNote", () => {
  test("returns null without a reference image", () => {
    expect(buildRemixNote(undefined, ["imageGen"] as SkillId[])).toBeNull()
  })

  test("returns null when imageGen skill isn't enabled (would confuse the model)", () => {
    expect(
      buildRemixNote({ url: "https://x.test/img.png" }, ["webSearch"] as SkillId[]),
    ).toBeNull()
  })

  test("returns a note carrying the verbatim URL when imageGen is enabled", () => {
    const out = buildRemixNote(
      { url: "https://x.test/img.png" },
      ["imageGen"] as SkillId[],
    )
    expect(out).not.toBeNull()
    expect(out).toContain("https://x.test/img.png")
    expect(out).toContain("i2i mode")
    expect(out).toContain("generateImage")
  })
})

describe("lastUserText", () => {
  test("returns the last user-role message's content (plain string)", () => {
    expect(
      lastUserText([
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ]),
    ).toBe("second")
  })

  test("extracts the first text part from a multimodal user message", () => {
    expect(
      lastUserText([
        {
          role: "user",
          content: [
            { type: "image", image: "https://x.test/cat.png" },
            { type: "text", text: "describe this" },
          ],
        },
      ]),
    ).toBe("describe this")
  })

  test("returns '' when the last user message has no text part", () => {
    expect(
      lastUserText([
        {
          role: "user",
          content: [{ type: "image", image: "https://x.test/cat.png" }],
        },
      ]),
    ).toBe("")
  })

  test("returns '' when no user message is present", () => {
    expect(lastUserText([{ role: "assistant", content: "hi" }])).toBe("")
    expect(lastUserText([])).toBe("")
  })
})

describe("buildSystemPrompt — composition", () => {
  test("always includes the base 'helpful chat assistant' line", () => {
    const out = buildSystemPrompt({
      enabledSkillIds: [],
      skillRequestEntries: [],
      attachments: [],
    })
    expect(out).toContain("helpful chat assistant")
    expect(out).toContain("Markdown")
  })

  test("workspace prompt goes first when set (precedence over base guidance)", () => {
    const out = buildSystemPrompt({
      workspaceSystemPrompt: "You are a pirate.",
      enabledSkillIds: [],
      skillRequestEntries: [],
      attachments: [],
    })
    const pirateIdx = out.indexOf("pirate")
    const baseIdx = out.indexOf("helpful chat assistant")
    expect(pirateIdx).toBeGreaterThanOrEqual(0)
    expect(baseIdx).toBeGreaterThan(pirateIdx)
  })

  test("MCP note appears when active servers are passed; skipped otherwise", () => {
    const withMcp = buildSystemPrompt({
      enabledSkillIds: [],
      skillRequestEntries: [],
      attachments: [],
      mcpServers: [{ name: "github", toolCount: 3 }],
    })
    const withoutMcp = buildSystemPrompt({
      enabledSkillIds: [],
      skillRequestEntries: [],
      attachments: [],
    })
    expect(withMcp).toContain("github")
    expect(withoutMcp).not.toContain("MCP")
  })

  test("remix note appears only when both a reference and imageGen are present", () => {
    const both = buildSystemPrompt({
      enabledSkillIds: ["imageGen"] as SkillId[],
      skillRequestEntries: [],
      attachments: [],
      referenceImage: { url: "https://x.test/img.png" },
    })
    const refOnly = buildSystemPrompt({
      enabledSkillIds: [] as SkillId[],
      skillRequestEntries: [],
      attachments: [],
      referenceImage: { url: "https://x.test/img.png" },
    })
    expect(both).toContain("i2i mode")
    expect(refOnly).not.toContain("i2i mode")
  })
})
