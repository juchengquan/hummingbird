/**
 * Run sessions end to end on the client: recorded agent-py streams served
 * by a fake `fetch`, read by the transport, checked and applied by
 * `@ag-ui/client` (`HummingbirdRunAgent`: enforce → verify → apply), folded
 * by the reducer into a model of the store message.
 */

import { describe, expect, test } from "bun:test"

import {
  fakeFetch,
  fixtureNames,
  loadFixture,
  memoryStorage,
  messageOf,
  ModelSink,
  sseResponse,
} from "./fixtures"
import { toPendingInterrupt } from "./interrupts"
import { framesFromView, reduceRunEvents, viewFromMessages, type RunTurnView } from "./reducer"
import { loadRunToken, saveRunToken } from "./run-tokens"
import { rejoinRunSession, resumeRunSession, startRunSession } from "./session"
import type { Interrupt, RunsTarget, StartRunRequest } from "./types"

const SIGNED_IN: RunsTarget = { baseUrl: "https://agent.example", authToken: "jwt" }
const ANON: RunsTarget = { baseUrl: "https://agent.example", authToken: null }

function bodyFor(name: string): StartRunRequest {
  const started = loadFixture(name).items[0].event as unknown as { runId: string; threadId: string }
  return { threadId: started.threadId, runId: started.runId, messages: [] }
}

/** Tool calls / activities by id, independent of order. */
function shape(view: RunTurnView) {
  return {
    text: view.text,
    reasoning: view.reasoning,
    toolCalls: view.toolCalls
      .map((c) => ({ id: c.id, name: c.name, summary: c.result?.summary ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    activities: view.activities
      .map((a) => ({ id: a.messageId, type: a.activityType, content: a.content }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

// Tails from a mid-run cursor can't be checked from scratch (a content
// event without its start) — that's why a rejoin replays from "0".
const TAILS = new Set(["memory-rejoin-after-2.0", "memory-rejoin-after-2"])
// A live rewind restarts the stream; covered separately.
const COMPLETE = fixtureNames().filter((n) => !TAILS.has(n) && n !== "stream-rewind-live")

describe("@ag-ui/client accepts every recorded stream (start → verify → apply → reducer)", () => {
  for (const name of COMPLETE) {
    test(name, async () => {
      const fixture = loadFixture(name)
      const { fetch, calls } = fakeFetch(() => sseResponse(fixture.body))
      const sink = new ModelSink()
      const session = startRunSession(bodyFor(name), { target: SIGNED_IN, sink, fetch })
      const result = await session.done
      const direct = reduceRunEvents(fixture.items.map((i) => i.event))

      expect(calls).toHaveLength(1)
      // Same outcome and message as the pure fold — nothing was rejected.
      expect(result.outcome).toEqual(direct.state.outcome)
      expect(sink.message).toEqual(messageOf(framesFromView(direct.state.view)))
      // @ag-ui/client's own state of the run agrees with the reducer's view
      // (its messages hold exactly this run's output).
      expect(shape(viewFromMessages(result.messages))).toEqual(shape(direct.state.view))
      // The cursor is the last SSE id of the stream.
      const lastId = [...fixture.items].reverse().find((i) => i.cursor)?.cursor ?? "0"
      expect(result.cursor).toBe(lastId)
    })
  }
})

describe("rejoin", () => {
  test("a mid-run tail is rejected by the verifier (hence replay from 0)", async () => {
    const fixture = loadFixture("memory-rejoin-after-2")
    const { fetch } = fakeFetch(() => sseResponse(fixture.body))
    const session = rejoinRunSession(
      { runId: bodyFor("memory-rejoin-full").runId, threadId: bodyFor("memory-rejoin-full").threadId },
      { target: SIGNED_IN, sink: new ModelSink(), fetch },
    )
    const { outcome } = await session.done
    expect(outcome?.type).toBe("error")
  })

  test("replays from 0, quietly up to the saved cursor, then one reset and live frames", async () => {
    const fixture = loadFixture("memory-rejoin-full")
    const { fetch, calls } = fakeFetch(() => sseResponse(fixture.body))
    const sink = new ModelSink()
    const frames: string[] = []
    const wrapped = {
      frame: (f: Parameters<ModelSink["frame"]>[0]) => {
        frames.push(f.type ?? "")
        sink.frame(f)
      },
      clear: () => {
        frames.push("CLEAR")
        sink.clear()
      },
    }
    const { runId, threadId } = bodyFor("memory-rejoin-full")
    const session = rejoinRunSession({ runId, threadId, quietUntil: "5" }, { target: SIGNED_IN, sink: wrapped, fetch })
    const { outcome } = await session.done
    expect(calls[0].url).toBe(`https://agent.example/v1/runs/${runId}/events`)
    expect(calls[0].headers["Last-Event-ID"]).toBeUndefined()
    expect(outcome?.type).toBe("success")
    // Entries ≤ 5 (two text deltas, the tool call and its result) fold into
    // one reset; the rest of the run streams in as frames.
    expect(frames).toEqual(["CLEAR", "text", "tool_call", "tool_result", "text"])
    expect(sink.message.content).toBe("first part second partFinished.")
    expect(sink.clears).toBe(1)
  })

  test("a quiet rejoin of a finished run resets once at the closing event", async () => {
    const fixture = loadFixture("stream-parts")
    const { fetch } = fakeFetch(() => sseResponse(fixture.body))
    const sink = new ModelSink()
    const { runId, threadId } = bodyFor("stream-parts")
    const session = rejoinRunSession({ runId, threadId, quietUntil: "999" }, { target: SIGNED_IN, sink, fetch })
    const result = await session.done
    expect(sink.clears).toBe(1)
    expect(sink.message).toEqual(messageOf(framesFromView(result.state.view)))
    expect(sink.message.images).toHaveLength(1)
  })

  test("a live rewind past what was shown replays the run and resets the message", async () => {
    const live = loadFixture("stream-rewind-live")
    const replay = loadFixture("stream-rewind-replay")
    const { fetch, calls } = fakeFetch((_c, i) => sseResponse(i === 0 ? live.body : replay.body))
    const sink = new ModelSink()
    const { runId, threadId } = bodyFor("stream-rewind-live")
    const session = rejoinRunSession({ runId, threadId }, { target: SIGNED_IN, sink, fetch })
    const { outcome } = await session.done
    expect(calls).toHaveLength(2)
    expect(outcome?.type).toBe("success")
    expect(sink.message.content).toBe("Checking. Done.")
  })
})

describe("start", () => {
  test("anonymous: the run token is stored, then dropped when the run ends", async () => {
    const fixture = loadFixture("memory-anonymous")
    const tokens = memoryStorage()
    const token = "t".repeat(24)
    let stored = null as string | null
    const { fetch, calls } = fakeFetch(() => sseResponse(fixture.body, { "X-Run-Token": token }))
    const body = bodyFor("memory-anonymous")
    const session = startRunSession(body, {
      target: ANON,
      sink: new ModelSink(),
      fetch,
      tokens,
      onStarted: (info) => {
        stored = loadRunToken(body.runId, tokens)
        expect(info.runToken).toBe(token)
      },
    })
    await session.done
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(stored).toBe(token)
    expect(loadRunToken(body.runId, tokens)).toBeNull()
  })

  test("anonymous interrupt: the token is kept for the answer", async () => {
    const fixture = loadFixture("memory-interrupt-anonymous")
    const tokens = memoryStorage()
    const { fetch } = fakeFetch(() => sseResponse(fixture.body, { "X-Run-Token": "k".repeat(24) }))
    const body = bodyFor("memory-interrupt-anonymous")
    const { outcome } = await startRunSession(body, { target: ANON, sink: new ModelSink(), fetch, tokens }).done
    expect(outcome?.type).toBe("interrupt")
    expect(loadRunToken(body.runId, tokens)).toBe("k".repeat(24))
  })

  test("HTTP errors become error outcomes with chat's MessageError", async () => {
    for (const [status, code, mapped] of [
      [409, "run_id_conflict", "unknown"],
      [409, "run_already_resumed", "unknown"],
      [429, "rate_limit", "rate_limit"],
      [401, "auth_required", "auth_required"],
      [400, "unknown_model", "unknown_model"],
    ] as const) {
      const { fetch } = fakeFetch(
        () => new Response(JSON.stringify({ code, message: `m-${code}` }), { status }),
      )
      const { outcome } = await startRunSession(bodyFor("memory-interactive"), {
        target: SIGNED_IN,
        sink: new ModelSink(),
        fetch,
      }).done
      expect(outcome).toMatchObject({
        type: "error",
        code,
        error: { code: mapped, status, detail: `m-${code}` },
      })
    }
  })

  test("a network failure before any response is a `network` error outcome", async () => {
    const fetch = (async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof globalThis.fetch
    const { outcome } = await startRunSession(bodyFor("memory-interactive"), {
      target: SIGNED_IN,
      sink: new ModelSink(),
      fetch,
    }).done
    expect(outcome).toMatchObject({ type: "error", code: "network", error: { code: "network" } })
  })
})

/** A response whose body the test feeds by hand. */
function openStream(): { response: Response; push: (s: string) => void; end: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const enc = new TextEncoder()
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    push: (s) => controller.enqueue(enc.encode(s)),
    end: () => controller.close(),
  }
}

describe("stop", () => {
  test("cancel() cancels on the server and the stream ends cancelled", async () => {
    const fixture = loadFixture("memory-cancel")
    const frames = fixture.body.split("\n\n").filter(Boolean).map((f) => `${f}\n\n`)
    const live = openStream()
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/cancel")) {
        // The server closes the stream with the cancelled outcome.
        live.push(frames.at(-1)!)
        live.end()
        return new Response(JSON.stringify({ status: "cancelled" }), { status: 200 })
      }
      return live.response
    })
    const sink = new ModelSink()
    const body = bodyFor("memory-cancel")
    const session = startRunSession(body, { target: SIGNED_IN, sink, fetch })
    for (const f of frames.slice(0, -1)) live.push(f)
    await new Promise((r) => setTimeout(r, 20))
    expect(sink.message.content).toBe("partial answer")
    expect(await session.cancel()).toEqual({ ok: true })
    const { outcome } = await session.done
    expect(outcome).toEqual({ type: "cancelled" })
    expect(calls[1]).toMatchObject({
      url: `https://agent.example/v1/runs/${body.runId}/cancel`,
      method: "POST",
      headers: { Authorization: "Bearer jwt" },
    })
  })

  test("detach() stops reading without cancelling; the outcome is null", async () => {
    const live = openStream()
    const { fetch, calls } = fakeFetch(() => live.response)
    const fixture = loadFixture("memory-cancel")
    const session = startRunSession(bodyFor("memory-cancel"), { target: SIGNED_IN, sink: new ModelSink(), fetch })
    live.push(fixture.body.split("\n\n")[0] + "\n\n")
    await new Promise((r) => setTimeout(r, 10))
    session.detach()
    const { outcome } = await session.done
    expect(outcome).toBeNull()
    expect(calls).toHaveLength(1)
  })
})

describe("resume", () => {
  const interrupted = loadFixture("memory-interrupt-choice")
  const closing = interrupted.items.at(-1)!.event as unknown as {
    outcome: { interrupts: Interrupt[] }
  }
  const interrupts = closing.outcome.interrupts.map(toPendingInterrupt)
  const previousRunId = bodyFor("memory-interrupt-choice").runId

  test("answers every interrupt in a new run on the same thread", async () => {
    const resumed = loadFixture("memory-resume-choice")
    const tokens = memoryStorage()
    saveRunToken(previousRunId, "p".repeat(24), tokens)
    const { fetch, calls } = fakeFetch(() => sseResponse(resumed.body, { "X-Run-Token": "p".repeat(24) }))
    const sink = new ModelSink()
    const input = { ...bodyFor("memory-resume-choice"), forwardedProps: { model: "m" } }
    const session = resumeRunSession(
      { input, previousRunId, interrupts, answers: { "c-ask": { selection: ["a"] } } },
      { target: ANON, sink, fetch, tokens },
    )
    const { outcome } = await session.done
    expect(outcome?.type).toBe("success")
    expect(calls[0].headers["X-Run-Token"]).toBe("p".repeat(24))
    expect(calls[0].body).toMatchObject({
      runId: input.runId,
      threadId: input.threadId,
      forwardedProps: { model: "m", previousRunId },
      resume: [{ interruptId: "c-ask", status: "resolved", payload: { selection: ["a"] } }],
    })
    expect(sink.message.toolCalls).toMatchObject([{ id: "c-ask", status: "done", summary: "User selected: a" }])
    expect(sink.message.content).toBe("You picked A.")
  })

  test("an unanswered interrupt throws before anything is sent", () => {
    expect(() =>
      resumeRunSession(
        { input: bodyFor("memory-resume-choice"), previousRunId, interrupts, answers: {} },
        { target: SIGNED_IN, sink: new ModelSink() },
      ),
    ).toThrow(/Unanswered/)
  })

  test("an expired interrupt can only be cancelled (@ag-ui/client's check)", async () => {
    const expired = interrupts.map((i) =>
      toPendingInterrupt({ ...i.raw, expiresAt: "2000-01-01T00:00:00Z" }),
    )
    const { fetch, calls } = fakeFetch(() => sseResponse(loadFixture("memory-resume-choice").body))
    const { outcome } = await resumeRunSession(
      { input: bodyFor("memory-resume-choice"), previousRunId, interrupts: expired, answers: { "c-ask": { selection: ["a"] } } },
      { target: SIGNED_IN, sink: new ModelSink(), fetch },
    ).done
    expect(outcome?.type).toBe("error")
    expect(calls).toHaveLength(0)
  })
})
