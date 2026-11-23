/** The runs client's small modules: SSE parsing, errors, run tokens, the
 *  active-run pointers, request building and interrupts. */

import { describe, expect, test } from "bun:test"

import type { Message } from "@/shared/types"

import {
  clearActiveRun,
  listActiveRuns,
  loadActiveRun,
  MAX_AGE_MS as RUN_MAX_AGE,
  saveActiveRun,
  updateActiveRun,
} from "./active-run"
import { buildRunInput, toRunMessages } from "./build-input"
import { messageErrorFor, RunsError } from "./errors"
import { memoryStorage } from "./fixtures"
import { buildResume, pendingInterrupts, toPendingInterrupt } from "./interrupts"
import { dropRunToken, loadRunToken, MAX_AGE_MS as TOKEN_MAX_AGE, saveRunToken } from "./run-tokens"
import { parseSseBody, SseParser } from "./sse"
import type { Interrupt } from "./types"

describe("SseParser", () => {
  test("ids only on messages that carry one; comments skipped; multi-line data", () => {
    const body = `: keep-alive\n\ndata: {"a":1}\n\nid: 3.1\ndata: x\ndata: y\n\nid: 4\ndata:no-space\n\n`
    expect(parseSseBody(body)).toEqual([
      { data: '{"a":1}' },
      { id: "3.1", data: "x\ny" },
      { id: "4", data: "no-space" },
    ])
  })

  test("any chunking, CRLF and CR line ends", () => {
    const body = "id: 1\r\ndata: one\r\n\r\nid: 2\rdata: two\r\r"
    const parser = new SseParser()
    const out = [...body].flatMap((ch) => parser.push(ch))
    expect(out).toEqual([
      { id: "1", data: "one" },
      { id: "2", data: "two" },
    ])
  })

  test("a message cut short (no blank line) is not dispatched", () => {
    expect(parseSseBody("id: 1\ndata: half")).toEqual([])
  })
})

describe("errors", () => {
  test("messageErrorFor maps wire codes onto MessageError codes", () => {
    expect(messageErrorFor("rate_limit")).toEqual({ code: "rate_limit" })
    expect(messageErrorFor("upstream", { detail: "x" })).toEqual({ code: "provider", detail: "x" })
    expect(messageErrorFor("unavailable", { status: 503 })).toEqual({ code: "provider", status: 503 })
    expect(messageErrorFor("run_answer_applied", { status: 409 })).toEqual({ code: "answer_applied", status: 409 })
    expect(messageErrorFor("run_id_conflict", { status: 409 })).toEqual({ code: "unknown", status: 409 })
    expect(messageErrorFor(undefined, { status: 429 })).toEqual({ code: "rate_limit", status: 429 })
    expect(messageErrorFor(undefined, { status: 401 })).toEqual({ code: "auth", status: 401 })
    expect(messageErrorFor("auth_required", { model: "m" })).toEqual({ code: "auth_required", model: "m" })
  })

  test("RunsError → MessageError", () => {
    const e = new RunsError("http", "run_already_resumed", "Already answered.", 409)
    expect(e.toMessageError("m")).toEqual({
      code: "unknown",
      status: 409,
      model: "m",
      detail: "Already answered.",
    })
    expect(new RunsError("network", "network", "down").toMessageError()).toEqual({
      code: "network",
      detail: "down",
    })
  })
})

describe("run tokens", () => {
  test("save / load / drop, and expiry", () => {
    const s = memoryStorage()
    saveRunToken("r1", "tok", s, 1000)
    saveRunToken("r2", "tok2", s, 1000)
    expect(loadRunToken("r1", s, 2000)).toBe("tok")
    dropRunToken("r1", s, 2000)
    expect(loadRunToken("r1", s, 2000)).toBeNull()
    expect(loadRunToken("r2", s, 1000 + TOKEN_MAX_AGE + 1)).toBeNull()
    dropRunToken("nope", s, 1000 + TOKEN_MAX_AGE + 1)
    expect(s.map.size).toBe(0)
  })

  test("no storage, or corrupt storage, never throws", () => {
    expect(() => saveRunToken("r", "t", null)).not.toThrow()
    expect(loadRunToken("r", null)).toBeNull()
    const s = memoryStorage()
    s.setItem("humm.runTokens", "{oops")
    expect(loadRunToken("r", s)).toBeNull()
  })
})

describe("active-run pointers", () => {
  const base = {
    runId: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
    threadId: "11111111-2222-4333-8444-555555555555",
    conversationId: "c1",
    messageId: "m1",
    status: "running" as const,
    cursor: "0",
    anonymous: true,
  }

  test("one slot per conversation; update/clear guard on the run id", () => {
    const s = memoryStorage()
    saveActiveRun(base, s, 0)
    saveActiveRun({ ...base, conversationId: "c2" }, s, 0)
    updateActiveRun("c1", base.runId, { cursor: "7.1" }, s, 10)
    updateActiveRun("c1", "11111111-0000-4000-8000-000000000000", { cursor: "9" }, s, 10)
    expect(loadActiveRun("c1", s, 10)).toMatchObject({ cursor: "7.1", updatedAt: new Date(10).toISOString() })
    clearActiveRun("c1", "11111111-0000-4000-8000-000000000000", s, 10)
    expect(loadActiveRun("c1", s, 10)).not.toBeNull()
    clearActiveRun("c1", base.runId, s, 10)
    expect(loadActiveRun("c1", s, 10)).toBeNull()
    expect(listActiveRuns(s, 10).map((r) => r.conversationId)).toEqual(["c2"])
  })

  test("stale pointers age out", () => {
    const s = memoryStorage()
    saveActiveRun(base, s, 0)
    expect(loadActiveRun("c1", s, RUN_MAX_AGE + 1)).toBeNull()
  })
})

describe("buildRunInput", () => {
  const msg = (id: string, role: Message["role"], content: string, extra: Partial<Message> = {}): Message => ({
    id,
    role,
    content,
    timestamp: new Date(0),
    ...extra,
  })

  test("history is text-only; compressed and empty assistant messages are dropped", () => {
    expect(
      toRunMessages([
        msg("u0", "user", "old", { compressed: true }),
        msg("a0", "assistant", "recap"),
        msg("u1", "user", "hi"),
        msg("a1", "assistant", "", { error: { code: "network" } }),
        msg("u2", "user", "again"),
      ]),
    ).toEqual([
      { id: "a0", role: "assistant", content: "recap" },
      { id: "u1", role: "user", content: "hi" },
      { id: "u2", role: "user", content: "again" },
    ])
  })

  test("options ride in forwardedProps; threadId is the conversation", () => {
    const input = buildRunInput({
      conversationId: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
      history: [msg("u1", "user", "hi")],
      runId: "11111111-2222-4333-8444-555555555555",
      model: "anthropic/claude-sonnet-4.6",
      systemPrompt: "Be terse.",
      skills: [{ id: "webSearch" }],
      workspaceId: "w1",
      forwardedProps: { requireApprovalFor: ["send"] },
    })
    expect(input).toEqual({
      threadId: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
      runId: "11111111-2222-4333-8444-555555555555",
      messages: [{ id: "u1", role: "user", content: "hi" }],
      forwardedProps: {
        requireApprovalFor: ["send"],
        model: "anthropic/claude-sonnet-4.6",
        systemPrompt: "Be terse.",
        skills: [{ id: "webSearch" }],
        workspaceId: "w1",
      },
    })
    const bare = buildRunInput({ conversationId: "c-legacy", history: [] })
    expect(bare.forwardedProps).toBeUndefined()
    expect(bare.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(bare.threadId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe("interrupts", () => {
  const approval: Interrupt = {
    id: "c2",
    reason: "approval",
    toolCallId: "c2",
    responseSchema: { type: "object" },
    metadata: { hummingbird: { tool: "send", args: { to: "bob" } } },
  }
  const choice: Interrupt = {
    id: "c3",
    reason: "choice",
    message: "Which?",
    metadata: { hummingbird: { options: [{ id: "a", label: "A" }, { bad: 1 }], multi: true } },
  }

  test("toPendingInterrupt unpacks metadata.hummingbird", () => {
    expect(toPendingInterrupt(approval)).toEqual({
      id: "c2",
      reason: "approval",
      toolCallId: "c2",
      responseSchema: { type: "object" },
      tool: "send",
      args: { to: "bob" },
      raw: approval,
    })
    expect(toPendingInterrupt(choice)).toMatchObject({
      message: "Which?",
      options: [{ id: "a", label: "A" }],
      multi: true,
    })
    expect(pendingInterrupts({ status: "interrupted", openInterrupts: [approval] })).toHaveLength(1)
    expect(pendingInterrupts({ status: "succeeded", openInterrupts: [] })).toEqual([])
  })

  test("buildResume answers exactly the open interrupts, shapes checked", () => {
    const open = [approval, choice].map(toPendingInterrupt)
    expect(buildResume(open, { c2: { approved: true }, c3: { cancelled: true } })).toEqual([
      { interruptId: "c2", status: "resolved", payload: { approved: true } },
      { interruptId: "c3", status: "cancelled" },
    ])
    expect(() => buildResume(open, { c2: { approved: true } })).toThrow(/Unanswered/)
    expect(() => buildResume(open, { c2: { approved: true }, c3: { selection: [] }, x: { value: "" } })).toThrow(
      /unknown/,
    )
    expect(() => buildResume(open, { c2: { value: "yes" }, c3: { selection: ["a"] } })).toThrow(/does not fit/)
  })
})
