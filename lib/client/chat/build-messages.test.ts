import { describe, expect, test } from "bun:test"
import type { Message } from "@/shared/types"

import { buildTransmittedMessages } from "./build-messages"

function msg(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  return {
    id: `${role}-${content.slice(0, 6)}`,
    role,
    content,
    timestamp: new Date("2026-01-01"),
    ...extra,
  }
}

describe("buildTransmittedMessages", () => {
  test("empty history → empty array", () => {
    expect(buildTransmittedMessages([], [])).toEqual([])
  })

  test("text-only history → text-only payload (no image, no array content)", () => {
    const out = buildTransmittedMessages(
      [msg("user", "Hi"), msg("assistant", "Hey")],
      []
    )
    expect(out).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hey" },
    ])
  })

  test("drops compressed messages", () => {
    const out = buildTransmittedMessages(
      [
        msg("user", "Old", { compressed: true }),
        msg("assistant", "Old reply", { compressed: true }),
        msg("user", "New"),
      ],
      []
    )
    expect(out).toEqual([{ role: "user", content: "New" }])
  })

  test("recap messages travel as regular assistant turns (not dropped)", () => {
    const out = buildTransmittedMessages(
      [
        msg("assistant", "Summary so far", { kind: "recap" }),
        msg("user", "Continue"),
      ],
      []
    )
    expect(out).toEqual([
      { role: "assistant", content: "Summary so far" },
      { role: "user", content: "Continue" },
    ])
  })

  test("images attach to the LAST message when it's a user turn", () => {
    const out = buildTransmittedMessages(
      [msg("assistant", "First"), msg("user", "What is this?")],
      ["data:image/png;base64,xxx"]
    )
    expect(out[0]).toEqual({ role: "assistant", content: "First" })
    expect(out[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image", image: "data:image/png;base64,xxx" },
      ],
    })
  })

  test("images NOT attached when the last message is an assistant turn", () => {
    const out = buildTransmittedMessages(
      [msg("user", "Hello"), msg("assistant", "Hi there")],
      ["data:image/png;base64,xxx"]
    )
    expect(out[0]).toEqual({ role: "user", content: "Hello" })
    expect(out[1]).toEqual({ role: "assistant", content: "Hi there" })
  })

  test("images NOT attached when attachedImageUrls is empty", () => {
    const out = buildTransmittedMessages([msg("user", "Hello")], [])
    expect(out[0]).toEqual({ role: "user", content: "Hello" })
  })

  test("multiple images attach in order", () => {
    const out = buildTransmittedMessages(
      [msg("user", "Compare these")],
      ["data:image/png;base64,A", "data:image/png;base64,B"]
    )
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Compare these" },
        { type: "image", image: "data:image/png;base64,A" },
        { type: "image", image: "data:image/png;base64,B" },
      ],
    })
  })

  test("image attach position is the post-compression last user (compressed messages don't count as 'last')", () => {
    const out = buildTransmittedMessages(
      [
        msg("user", "OldLast", { compressed: true }),
        msg("user", "NewLast"),
      ],
      ["data:image/png;base64,X"]
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "NewLast" },
        { type: "image", image: "data:image/png;base64,X" },
      ],
    })
  })
})
