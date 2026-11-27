/** `buildRunInput` — attachments and reasoning effort (wave 4b-D), the
 *  contract-0.4.0 options and local MCP credentials in `state` (wave 5a).
 *  The text-only history and the base options are covered in
 *  `support.test.ts`. */

import { describe, expect, test } from "bun:test"

import type { Message } from "@/shared/types"

import {
  buildExplainRunInput,
  buildRunInput,
  fitSandboxFilesToRun,
  LOCAL_MCP_STATE_KEY,
  RUN_INLINE_SANDBOX_BUDGET,
  localMcpCredentialsOf,
  toRunMessages,
  utf8ToBase64,
} from "./build-input"
import type { StartRunRequest } from "./types"

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

describe("buildRunInput — contract 0.4.0 options (wave 5a)", () => {
  const history = [msg("u1", "user", "hi")]

  test("every option maps onto its forwardedProps key; credentials go in state only", () => {
    const creds = { "srv-1": { type: "bearer", headers: { Authorization: "Bearer s3cret" } } }
    const input = buildRunInput({
      conversationId: "c1",
      history,
      runId: "r1",
      research: true,
      allowedMcpServerIds: ["srv-1"],
      attachments: [
        { kind: "file", fileId: "f1", name: "a.pdf", retrievalMode: "rag" },
        { kind: "bookmark", url: "https://x", title: "X", text: "page" },
      ],
      memoryBypass: true,
      verifyCitations: true,
      referenceImage: { url: "https://img/1.png" },
      localFilesOnly: true,
      localMcpServers: [{ id: "srv-1", name: "Local", url: "http://localhost:9/mcp", transport: "http" }],
      localMcpCredentials: creds,
    })
    expect(input.forwardedProps).toEqual({
      research: true,
      allowedMcpServerIds: ["srv-1"],
      attachments: [
        { kind: "file", fileId: "f1", name: "a.pdf", retrievalMode: "rag" },
        { kind: "bookmark", url: "https://x", title: "X", text: "page" },
      ],
      memoryBypass: true,
      verifyCitations: true,
      referenceImage: { url: "https://img/1.png" },
      localFilesOnly: true,
      localMcpServers: [{ id: "srv-1", name: "Local", url: "http://localhost:9/mcp", transport: "http" }],
    })
    expect(input.state).toEqual({ [LOCAL_MCP_STATE_KEY]: creds })
    expect(JSON.stringify(input.forwardedProps)).not.toContain("s3cret")
    expect(localMcpCredentialsOf(input)).toEqual(creds)
  })

  test("false / empty options are left out; an empty allow-list is kept (no MCP at all)", () => {
    const input = buildRunInput({
      conversationId: "c1",
      history,
      runId: "r1",
      research: false,
      memoryBypass: false,
      verifyCitations: false,
      localFilesOnly: false,
      attachments: [],
      localMcpServers: [],
      localMcpCredentials: {},
      allowedMcpServerIds: [],
    })
    expect(input.forwardedProps).toEqual({ allowedMcpServerIds: [] })
    expect(input.state).toBeUndefined()
    expect(localMcpCredentialsOf(input)).toBeUndefined()
  })

  test("a resume rebuilt from the previous request keeps its options and re-sends the credentials", () => {
    const creds = { "srv-1": { headers: { Authorization: "k" } } }
    const first = buildRunInput({
      conversationId: "c1",
      history,
      runId: "r1",
      memoryBypass: true,
      localMcpServers: [{ id: "srv-1", name: "Local", url: "http://localhost:9/mcp" }],
      localMcpCredentials: creds,
    })
    const resume = buildRunInput({
      conversationId: "c1",
      history,
      runId: "r2",
      forwardedProps: first.forwardedProps,
      localMcpCredentials: localMcpCredentialsOf(first),
    })
    expect(resume.forwardedProps).toEqual(first.forwardedProps)
    expect(resume.state).toEqual(first.state)
  })

  test("localMcpCredentialsOf ignores other state shapes", () => {
    const of = (state: unknown) => localMcpCredentialsOf({ state } as Pick<StartRunRequest, "state">)
    expect(of(undefined)).toBeUndefined()
    expect(of([1])).toBeUndefined()
    expect(of({ other: 1 })).toBeUndefined()
    expect(of({ [LOCAL_MCP_STATE_KEY]: "x" })).toBeUndefined()
  })
})

describe("buildRunInput — runCode's files (wave 8, Q92)", () => {
  const CONV = "00000000-0000-4000-8000-0000000000c1"
  const history: Message[] = [{ id: "u1", role: "user", content: "Plot it", timestamp: new Date(0) }]

  test("sandboxFiles ride in forwardedProps; none → no key", () => {
    const files = [{ name: "a.csv", fileId: "f1" }, { name: "b.csv", fileId: "f2", dataBase64: "YQ==" }]
    const body = buildRunInput({ conversationId: CONV, history, sandboxFiles: files })
    expect(body.forwardedProps?.sandboxFiles).toEqual(files)
    expect(buildRunInput({ conversationId: CONV, history, sandboxFiles: [] }).forwardedProps).toBeUndefined()
  })

  test("inline files are kept only while they fit the request; cloud files always", () => {
    const big = "A".repeat(RUN_INLINE_SANDBOX_BUDGET - 10)
    const fitted = fitSandboxFilesToRun([
      { name: "one", fileId: "1", dataBase64: big },
      { name: "cloud", fileId: "2" },
      { name: "two", fileId: "3", dataBase64: "A".repeat(20) },
      { name: "tiny", fileId: "4", dataBase64: "AAAA" },
    ])
    expect(fitted.map((f) => f.name)).toEqual(["one", "cloud", "tiny"])
  })
})

describe("buildRunInput — ephemeral (0.8.0, Q136)", () => {
  test("ephemeral rides in forwardedProps only when true", () => {
    const base = { conversationId: "c1", history: [msg("u1", "user", "hi")] }
    expect(buildRunInput({ ...base, ephemeral: true }).forwardedProps).toEqual({ ephemeral: true })
    expect(buildRunInput({ ...base, ephemeral: false }).forwardedProps).toBeUndefined()
  })
})

describe("buildExplainRunInput (wave 12, Q125/Q135)", () => {
  test("ephemeral, a fresh thread, the prompt last, model + workspace prompt, nothing else", () => {
    const body = buildExplainRunInput({
      history: [msg("u1", "user", "hi"), msg("a1", "assistant", ""), msg("a2", "assistant", "hello")],
      prompt: "Explain X",
      model: "anthropic/claude-haiku-4.5",
      systemPrompt: "Be brief.",
    })
    expect(body.forwardedProps).toEqual({
      ephemeral: true,
      model: "anthropic/claude-haiku-4.5",
      systemPrompt: "Be brief.",
    })
    expect(body.threadId).not.toBe(body.runId)
    expect(body.state).toBeUndefined()
    const messages = body.messages as Array<{ id: string; role: string; content: unknown }>
    expect(messages.slice(0, 2)).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "a2", role: "assistant", content: "hello" },
    ])
    expect(messages[2]).toMatchObject({ role: "user", content: "Explain X" })
  })
})
