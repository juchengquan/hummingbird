/** `buildRunInput` — attachments and reasoning effort (wave 4b-D). The
 *  text-only history and the base options are covered in
 *  `support.test.ts`. */

import { describe, expect, test } from "bun:test"

import type { Message } from "@/shared/types"

import { buildRunInput, toRunMessages, utf8ToBase64 } from "./build-input"

const msg = (id: string, role: Message["role"], content: string): Message => ({
  id,
  role,
  content,
  timestamp: new Date(0),
})

const PNG = "iVBORw0KGgo="

describe("toRunMessages — attachments", () => {
  test("documents then images then the text, on the newest user message only", () => {
    const out = toRunMessages([msg("u0", "user", "earlier"), msg("a0", "assistant", "ok"), msg("u1", "user", "Compare.")], {
      images: [`data:image/png;base64,${PNG}`, "https://cdn.example/b.webp"],
      documents: [
        { name: "q3.txt", text: "Q3 revenue was up." },
        { name: "notes.md", text: "héllo ✓", truncated: true },
      ],
    })
    expect(out.slice(0, 2)).toEqual([
      { id: "u0", role: "user", content: "earlier" },
      { id: "a0", role: "assistant", content: "ok" },
    ])
    expect(out[2]).toEqual({
      id: "u1",
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "data", mimeType: "text/plain", value: "UTMgcmV2ZW51ZSB3YXMgdXAu" },
          metadata: { name: "q3.txt" },
        },
        {
          type: "document",
          source: { type: "data", mimeType: "text/plain", value: "aMOpbGxvIOKckw==" },
          metadata: { name: "notes.md", truncated: true },
        },
        { type: "image", source: { type: "data", mimeType: "image/png", value: PNG } },
        { type: "image", source: { type: "url", value: "https://cdn.example/b.webp" } },
        { type: "text", text: "Compare." },
      ],
    })
  })

  test("no attachments, or a newest message that is not the user's: plain text", () => {
    const history = [msg("u1", "user", "hi")]
    expect(toRunMessages(history)).toEqual([{ id: "u1", role: "user", content: "hi" }])
    expect(toRunMessages(history, { images: [], documents: [] })).toEqual([
      { id: "u1", role: "user", content: "hi" },
    ])
    expect(toRunMessages([...history, msg("a1", "assistant", "yo")], { images: [`data:image/png;base64,${PNG}`] })).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "yo" },
    ])
  })

  test("an image-only turn has no empty text part; a non-base64 data URL goes as a URL (the backend refuses it)", () => {
    const [m] = toRunMessages([msg("u1", "user", "")], { images: ["data:image/svg+xml,<svg/>"] })
    expect(m).toEqual({
      id: "u1",
      role: "user",
      content: [{ type: "image", source: { type: "url", value: "data:image/svg+xml,<svg/>" } }],
    })
  })

  test("utf8ToBase64 round-trips large and non-ASCII text", () => {
    const text = "é✓😀".repeat(50_000)
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(utf8ToBase64(text)), (c) => c.charCodeAt(0)))
    expect(decoded).toBe(text)
  })
})

describe("buildRunInput — new options", () => {
  test("images / documents reach the last user message; reasoningEffort rides in forwardedProps", () => {
    const input = buildRunInput({
      conversationId: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
      history: [msg("u1", "user", "What is this?")],
      runId: "11111111-2222-4333-8444-555555555555",
      model: "anthropic/claude-sonnet-4.6",
      images: [`data:image/jpeg;base64,${PNG}`],
      documents: [{ name: "a.txt", text: "hi" }],
      reasoningEffort: "high",
    })
    expect(input.forwardedProps).toEqual({ model: "anthropic/claude-sonnet-4.6", reasoningEffort: "high" })
    expect(input.messages).toEqual([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "document", source: { type: "data", mimeType: "text/plain", value: "aGk=" }, metadata: { name: "a.txt" } },
          { type: "image", source: { type: "data", mimeType: "image/jpeg", value: PNG } },
          { type: "text", text: "What is this?" },
        ],
      },
    ])
  })

  test("existing callers are unchanged", () => {
    const input = buildRunInput({ conversationId: "c1", history: [msg("u1", "user", "hi")], runId: "r1" })
    expect(input.messages).toEqual([{ id: "u1", role: "user", content: "hi" }])
    expect(input.forwardedProps).toBeUndefined()
  })
})
