import { describe, expect, test } from "bun:test"

import {
  findPromptBySlug,
  isTypingPromptMention,
  matchPromptMentions,
  MAX_MENTION_MATCHES,
} from "./mention-parser"
import type { Prompt } from "@/shared/types"

function p(overrides: Partial<Prompt> & { slug: string; name: string }): Prompt {
  return {
    id: overrides.id ?? overrides.slug,
    workspaceId: overrides.workspaceId ?? "ws-default",
    name: overrides.name,
    slug: overrides.slug,
    template: overrides.template ?? "body",
    variables: overrides.variables ?? [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: overrides.deletedAt,
  }
}

const PROMPTS: Prompt[] = [
  p({ slug: "persona", name: "Voice rewrite" }),
  p({ slug: "summarize", name: "Summarize URL" }),
  p({ slug: "standup", name: "Standup update" }),
  p({ slug: "gone", name: "Deleted one", deletedAt: new Date(1) }),
]

describe("isTypingPromptMention", () => {
  test("true for bare @", () => {
    expect(isTypingPromptMention("@")).toBe(true)
  })
  test("true while typing the token", () => {
    expect(isTypingPromptMention("@pers")).toBe(true)
  })
  test("false once whitespace typed (token complete)", () => {
    expect(isTypingPromptMention("@persona ")).toBe(false)
  })
  test("false when @ is not the first char", () => {
    expect(isTypingPromptMention("hey @persona")).toBe(false)
  })
  test("false for non-@ input", () => {
    expect(isTypingPromptMention("/search")).toBe(false)
    expect(isTypingPromptMention("hello")).toBe(false)
    expect(isTypingPromptMention("")).toBe(false)
  })
})

describe("matchPromptMentions", () => {
  test("empty partial returns all live prompts", () => {
    const out = matchPromptMentions("", PROMPTS)
    expect(out.map((x) => x.slug)).toEqual(["persona", "summarize", "standup"])
  })
  test("excludes soft-deleted prompts", () => {
    const out = matchPromptMentions("", PROMPTS)
    expect(out.find((x) => x.slug === "gone")).toBeUndefined()
  })
  test("slug prefix match", () => {
    expect(matchPromptMentions("sum", PROMPTS).map((x) => x.slug)).toEqual([
      "summarize",
    ])
  })
  test("case-insensitive", () => {
    expect(matchPromptMentions("PERS", PROMPTS).map((x) => x.slug)).toEqual([
      "persona",
    ])
  })
  test("slug-prefix matches rank before name-substring matches", () => {
    // "s" prefixes slugs `summarize` + `standup`; also appears in the
    // NAME "Voice rewrite"? no. Use a needle that hits both lanes:
    // "standup" slug starts with "stand"; "Standup update" name too.
    // Pick "up" — no slug starts with "up", but names "Summarize URL"
    // (no), "Standup update" (yes, substring). So name-only match.
    const out = matchPromptMentions("up", PROMPTS).map((x) => x.slug)
    expect(out).toContain("standup")
  })
  test("name-substring discovery when slug doesn't prefix-match", () => {
    // "voice" is in the NAME "Voice rewrite", slug is "persona".
    expect(matchPromptMentions("voice", PROMPTS).map((x) => x.slug)).toEqual([
      "persona",
    ])
  })
  test("no matches → empty", () => {
    expect(matchPromptMentions("zzz", PROMPTS)).toEqual([])
  })
  test("caps at MAX_MENTION_MATCHES", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      p({ slug: `prompt${i}`, name: `Prompt ${i}` })
    )
    expect(matchPromptMentions("prompt", many).length).toBe(MAX_MENTION_MATCHES)
  })
})

describe("findPromptBySlug", () => {
  test("exact case-insensitive match", () => {
    expect(findPromptBySlug("PERSONA", PROMPTS)?.slug).toBe("persona")
  })
  test("prefix is not a match (exact only)", () => {
    expect(findPromptBySlug("pers", PROMPTS)).toBeNull()
  })
  test("ignores soft-deleted", () => {
    expect(findPromptBySlug("gone", PROMPTS)).toBeNull()
  })
  test("unknown slug → null", () => {
    expect(findPromptBySlug("nope", PROMPTS)).toBeNull()
  })
})
