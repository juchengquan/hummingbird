/**
 * Explain-selection on runs (wave 12, Q125/Q135/Q136): the popover is an
 * ephemeral interactive run on a fresh thread — history + the explain
 * prompt, the chat model, the workspace prompt, no skills. No mock, no
 * other path (wave 13).
 */

import { describe, expect, test } from "bun:test"

import type { RunSession, RunSessionOptions, RunSessionResult } from "@/client/runs/session"
import type { RunsTarget, StartRunRequest } from "@/client/runs/types"
import { AUTH_REQUIRED_MESSAGE } from "@/shared/api-errors"
import { explainSelectionPrompt } from "@/shared/selection-prompts"
import type { Message } from "@/shared/types"

import {
  streamExplanation,
  type ExplainDeps,
  type ExplainRequest,
  type ExplainSink,
} from "./explain-stream"

const msg = (id: string, role: Message["role"], content: string): Message => ({
  id,
  role,
  content,
  timestamp: new Date(0),
})

const REQ: ExplainRequest = {
  selection: "the mitochondria",
  contextMessages: [msg("conv-u1", "user", "Tell me about cells"), msg("conv-a1", "assistant", "Cells have…")],
  model: "anthropic/claude-haiku-4.5",
  workspaceSystemPrompt: "Be brief.",
}

const TARGET: RunsTarget = { baseUrl: "", authToken: "jwt" }

interface Recorder extends ExplainSink {
  log: string[]
  text: string
}

function recorder(): Recorder {
  const r: Recorder = {
    log: [],
    text: "",
    append(t) {
      r.text += t
      r.log.push(`append:${t}`)
    },
    reset() {
      r.text = ""
      r.log.push("reset")
    },
    error(message) {
      r.log.push(`error:${message}`)
    },
    authRequired() {
      r.log.push("authRequired")
    },
    done() {
      r.log.push("done")
    },
  }
  return r
}

type Outcome = RunSessionResult["outcome"]

/** A scripted run session: emits `frames` to the sink, then ends with `outcome`. */
function fakeSessions(script: { frames?: string[]; outcome: Outcome; hold?: boolean }) {
  const started: { body: StartRunRequest; opts: RunSessionOptions }[] = []
  let cancelled = 0
  let finish: () => void = () => {}
  const startRunSession = (body: StartRunRequest, opts: RunSessionOptions): RunSession => {
    started.push({ body, opts })
    const done = new Promise<RunSessionResult>((resolve) => {
      const end = () =>
        resolve({ outcome: script.outcome, state: {} as never, messages: [], cursor: "0" })
      queueMicrotask(() => {
        for (const f of script.frames ?? []) opts.sink.frame({ type: "text", value: f })
        if (script.hold) finish = end
        else end()
      })
    })
    return {
      runId: body.runId,
      threadId: body.threadId,
      done,
      async cancel() {
        cancelled += 1
        finish()
        return { ok: true as const }
      },
      detach() {},
    }
  }
  return {
    started,
    cancelled: () => cancelled,
    loadSession: async () => ({ startRunSession }),
  }
}

function deps(over: Partial<ExplainDeps> & Pick<ExplainDeps, "resolveRunsTarget">): ExplainDeps {
  return {
    loadSession: async () => {
      throw new Error("no session expected")
    },
    noModelProvider: () => false,
    ...over,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe("streamExplanation on runs", () => {
  test("an ephemeral run on a fresh thread: history + the prompt, model, workspace prompt, no skills; never /api/chat", async () => {
    const s = fakeSessions({ frames: ["It ", "powers cells."], outcome: { type: "success", result: {} as never, memoryTainted: false } })
    const d = deps({ resolveRunsTarget: async () => TARGET, loadSession: s.loadSession })
    const r = recorder()
    streamExplanation(REQ, r, d)
    await settle()
    expect(s.started).toHaveLength(1)
    const { body, opts } = s.started[0]!
    expect(opts.target).toBe(TARGET)
    // Not the conversation's thread; nothing about it is kept (no run tokens).
    expect(body.threadId).not.toBe("conv-u1")
    expect(body.threadId).toMatch(/^[0-9a-f-]{36}$/)
    expect(opts.tokens).toBeNull()
    expect(body.forwardedProps).toEqual({
      ephemeral: true,
      model: REQ.model,
      systemPrompt: "Be brief.",
    })
    expect(body.tools).toBeUndefined()
    const messages = body.messages as Array<{ role: string; content: unknown }>
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Tell me about cells"],
      ["assistant", "Cells have…"],
      ["user", explainSelectionPrompt("the mitochondria")],
    ])
    expect(r.text).toBe("It powers cells.")
    expect(r.log.at(-1)).toBe("done")
  })

  test("a fresh thread and run per explanation", async () => {
    const s = fakeSessions({ outcome: { type: "success", result: {} as never, memoryTainted: false } })
    const d = deps({ resolveRunsTarget: async () => TARGET, loadSession: s.loadSession })
    streamExplanation(REQ, recorder(), d)
    streamExplanation(REQ, recorder(), d)
    await settle()
    const [a, b] = s.started
    expect(a!.body.threadId).not.toBe(b!.body.threadId)
    expect(a!.body.runId).not.toBe(b!.body.runId)
  })

  test("auth_required: the sign-in message + toast, never the mock", async () => {
    const s = fakeSessions({
      outcome: { type: "error", code: "auth_required", message: "Sign in", error: { code: "auth_required" } },
    })
    const r = recorder()
    streamExplanation(REQ, r, deps({ resolveRunsTarget: async () => TARGET, loadSession: s.loadSession }))
    await settle()
    expect(r.log).toEqual([`error:${AUTH_REQUIRED_MESSAGE}`, "authRequired", "done"])
  })

  test("a failed run shows its message; the no-key mock never appears on runs", async () => {
    for (const code of ["provider", "auth", "unavailable"]) {
      const s = fakeSessions({
        outcome: { type: "error", code, message: `boom ${code}`, error: { code: "provider" } },
      })
      const r = recorder()
      streamExplanation(REQ, r, deps({ resolveRunsTarget: async () => TARGET, loadSession: s.loadSession }))
      await settle()
      expect(r.log).toEqual([`error:boom ${code}`, "done"])
    }
  })

  test("a reset (rejoin / rewind) clears the text before the replayed frames", async () => {
    const started: RunSessionOptions[] = []
    const d = deps({
      resolveRunsTarget: async () => TARGET,
      loadSession: async () => ({
        startRunSession: (body: StartRunRequest, opts: RunSessionOptions): RunSession => {
          started.push(opts)
          queueMicrotask(() => {
            opts.sink.frame({ type: "text", value: "stale" })
            opts.sink.clear()
            opts.sink.frame({ type: "text", value: "fresh" })
          })
          return {
            runId: body.runId,
            threadId: body.threadId,
            done: new Promise((res) =>
              setTimeout(() => res({ outcome: { type: "success", result: {} as never, memoryTainted: false }, state: {} as never, messages: [], cursor: "0" }), 0),
            ),
            cancel: async () => ({ ok: true as const }),
            detach() {},
          }
        },
      }),
    })
    const r = recorder()
    streamExplanation(REQ, r, d)
    await settle()
    expect(r.text).toBe("fresh")
  })

  test("closing the popover cancels the run and reports nothing more", async () => {
    const s = fakeSessions({ frames: ["Half"], outcome: { type: "cancelled" }, hold: true })
    const r = recorder()
    const abort = streamExplanation(REQ, r, deps({ resolveRunsTarget: async () => TARGET, loadSession: s.loadSession }))
    await settle()
    abort()
    await settle()
    expect(s.cancelled()).toBe(1)
    expect(r.log).toEqual(["append:Half"])
  })

  test("closed before the run started: no run is started at all", async () => {
    const s = fakeSessions({ outcome: { type: "success", result: {} as never, memoryTainted: false } })
    const r = recorder()
    const abort = streamExplanation(REQ, r, deps({ resolveRunsTarget: async () => TARGET, loadSession: s.loadSession }))
    abort()
    await settle()
    expect(s.started).toEqual([])
    expect(r.log).toEqual([])
  })

  test("no model provider on the deploy (Q131): says so, starts nothing", async () => {
    const s = fakeSessions({ outcome: { type: "success", result: {} as never, memoryTainted: false } })
    const r = recorder()
    const d = deps({ resolveRunsTarget: async () => TARGET, loadSession: s.loadSession, noModelProvider: () => true })
    streamExplanation(REQ, r, d)
    await settle()
    expect(s.started).toEqual([])
    expect(r.log[0]).toMatch(/^error:No model provider is configured on this deploy/)
    expect(r.log.at(-1)).toBe("done")
  })
})
