/**
 * The runs transport against a fake `fetch`: auth headers, run tokens,
 * cursors, reconnects, and errors.
 */

import { describe, expect, test } from "bun:test"

import { fakeFetch, loadFixture, memoryStorage, sseResponse } from "./fixtures"
import { RunsError } from "./errors"
import { loadRunToken, saveRunToken } from "./run-tokens"
import { cancelRun, getRun, rejoinRun, resumeRun, startRun, type RunStream } from "./transport"
import type { RunsTarget, StartRunRequest } from "./types"

const SIGNED_IN: RunsTarget = { baseUrl: "https://agent.example", authToken: "jwt" }
const ANON: RunsTarget = { baseUrl: "", authToken: null }
const RUN = "8a6e0804-0000-4000-8000-00000000f907"
const BODY: StartRunRequest = {
  threadId: "11111111-2222-4333-8444-555555555555",
  runId: RUN,
  messages: [{ id: "u1", role: "user", content: "hi" }],
}
const TOKEN = "a".repeat(24)

async function drain(stream: RunStream) {
  const out: Array<{ type: string; cursor: string | null }> = []
  for await (const item of stream) out.push({ type: item.event.type, cursor: item.cursor })
  return out
}

function runJson(status: string) {
  return new Response(JSON.stringify({ id: RUN, status, openInterrupts: [] }), {
    headers: { "Content-Type": "application/json" },
  })
}

describe("startRun", () => {
  test("signed in: POST /v1/runs with a Bearer, streams events with their cursors", async () => {
    const fixture = loadFixture("memory-interactive")
    const { fetch, calls } = fakeFetch(() => sseResponse(fixture.body))
    const cursors: string[] = []
    const stream = await startRun(BODY, { target: SIGNED_IN, fetch, onCursor: (c) => cursors.push(c) })
    const items = await drain(stream)
    expect(calls[0]).toMatchObject({
      url: "https://agent.example/v1/runs",
      method: "POST",
      headers: { Authorization: "Bearer jwt", Accept: "text/event-stream", "Content-Type": "application/json" },
      body: BODY,
    })
    expect(calls[0].headers["X-Run-Token"]).toBeUndefined()
    expect(items.map((i) => i.type)).toEqual(fixture.items.map((i) => i.event.type))
    expect(items.map((i) => i.cursor)).toEqual(fixture.items.map((i) => i.cursor))
    expect(cursors).toEqual(fixture.items.flatMap((i) => (i.cursor ? [i.cursor] : [])))
    expect(stream.cursor).toBe(cursors.at(-1)!)
    expect(stream.runToken).toBeNull()
  })

  test("anonymous: same origin, the token is captured and kept per run", async () => {
    const tokens = memoryStorage()
    const { fetch, calls } = fakeFetch(() =>
      sseResponse(loadFixture("memory-interrupt-anonymous").body, { "X-Run-Token": TOKEN }),
    )
    const stream = await startRun(BODY, { target: ANON, fetch, tokens })
    expect(calls[0].url).toBe("/v1/runs")
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(stream.runToken).toBe(TOKEN)
    await drain(stream)
    // Interrupted: kept for the answer.
    expect(loadRunToken(RUN, tokens)).toBe(TOKEN)
  })

  test("anonymous retry presents the run's own token; a resume the previous run's", async () => {
    const tokens = memoryStorage()
    saveRunToken(RUN, TOKEN, tokens)
    const { fetch, calls } = fakeFetch(() => sseResponse(loadFixture("memory-anonymous").body))
    await drain(await startRun(BODY, { target: ANON, fetch, tokens }))
    expect(calls[0].headers["X-Run-Token"]).toBe(TOKEN)

    const next = { ...BODY, runId: "9b6e0804-0000-4000-8000-00000000f907" }
    await drain(
      await resumeRun(
        { input: next, previousRunId: RUN, resume: [{ interruptId: "c2", status: "cancelled" }] },
        { target: ANON, fetch, tokens },
      ),
    )
    expect(calls[1].headers["X-Run-Token"]).toBe(TOKEN)
    expect(calls[1].body).toMatchObject({
      runId: next.runId,
      forwardedProps: { previousRunId: RUN },
      resume: [{ interruptId: "c2", status: "cancelled" }],
    })
  })

  test("a finished anonymous run's token is dropped", async () => {
    const tokens = memoryStorage()
    const { fetch } = fakeFetch(() =>
      sseResponse(loadFixture("memory-anonymous").body, { "X-Run-Token": TOKEN }),
    )
    await drain(await startRun(BODY, { target: ANON, fetch, tokens }))
    expect(loadRunToken(RUN, tokens)).toBeNull()
  })

  test("errors: the envelope's code and status, 429 → rate_limit", async () => {
    for (const [status, body, code] of [
      [409, { code: "run_id_conflict", message: "taken" }, "run_id_conflict"],
      [409, { code: "run_already_resumed", message: "answered" }, "run_already_resumed"],
      [429, {}, "rate_limit"],
      [422, { detail: "bad" }, "unknown"],
    ] as const) {
      const { fetch } = fakeFetch(() => new Response(JSON.stringify(body), { status }))
      const err = await startRun(BODY, { target: SIGNED_IN, fetch }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RunsError)
      expect(err).toMatchObject({ kind: "http", status, code })
    }
  })

  test("a 200 that isn't an event stream is a protocol error", async () => {
    const { fetch } = fakeFetch(() => new Response("{}", { headers: { "Content-Type": "application/json" } }))
    await expect(startRun(BODY, { target: SIGNED_IN, fetch })).rejects.toMatchObject({
      kind: "protocol",
    })
  })

  test("background runs are refused before any request", async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse(""))
    const body = { ...BODY, forwardedProps: { mode: "background" as const } }
    await expect(startRun(body, { target: SIGNED_IN, fetch })).rejects.toMatchObject({
      kind: "protocol",
    })
    expect(calls).toHaveLength(0)
  })

  test("an aborted signal is an `aborted` error", async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetch } = fakeFetch(() => sseResponse(""))
    await expect(
      startRun(BODY, { target: SIGNED_IN, fetch, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted" })
  })
})

describe("reconnect", () => {
  const full = loadFixture("memory-rejoin-full")
  const frames = full.body.split("\n\n").filter(Boolean).map((f) => `${f}\n\n`)
  // The stream breaks after the 3rd frame (TEXT_MESSAGE_START, id 2.0 — a
  // mid-entry cursor).
  const cut = 3
  const lastId = full.items[cut - 1].cursor!

  test("a broken stream rejoins after the last cursor; the repeated RUN_STARTED is dropped", async () => {
    const rejoined = loadFixture("memory-rejoin-after-2.0").body
    const { fetch, calls } = fakeFetch((_c, i) =>
      i === 0 ? sseResponse(frames.slice(0, cut).join("")) : sseResponse(rejoined),
    )
    const stream = await startRun(BODY, { target: SIGNED_IN, fetch, reconnectDelayMs: 1 })
    const items = await drain(stream)
    expect(lastId).toBe("2.0")
    expect(calls[1].url).toBe(`https://agent.example/v1/runs/${RUN}/events?after=2.0`)
    expect(calls[1].headers["Last-Event-ID"]).toBe("2.0")
    expect(calls[1].headers.Authorization).toBe("Bearer jwt")
    // One continuous sequence, exactly the full stream.
    expect(items.map((i) => i.type)).toEqual(full.items.map((i) => i.event.type))
    expect(items.filter((i) => i.type === "RUN_STARTED")).toHaveLength(1)
  })

  test("gives up with a network error after maxReconnects", async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse(frames.slice(0, cut).join("")))
    const stream = await startRun(BODY, {
      target: SIGNED_IN,
      fetch,
      maxReconnects: 2,
      reconnectDelayMs: 1,
    })
    const err = await drain(stream).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: "network", code: "network" })
    // The first request, then two reconnects that also broke.
    expect(calls).toHaveLength(3)
  })

  test("an HTTP error on the reconnect surfaces as is (e.g. a forgotten anonymous run)", async () => {
    const tokens = memoryStorage()
    const { fetch } = fakeFetch((_c, i) =>
      i === 0
        ? sseResponse(frames.slice(0, cut).join(""), { "X-Run-Token": TOKEN })
        : new Response(JSON.stringify({ code: "not_found", message: "gone" }), { status: 404 }),
    )
    const stream = await startRun(BODY, { target: ANON, fetch, tokens, reconnectDelayMs: 1 })
    const err = await drain(stream).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: "http", status: 404, code: "not_found" })
    expect(loadRunToken(RUN, tokens)).toBeNull()
  })
})

describe("auth refresh (bug 19)", () => {
  const full = loadFixture("memory-rejoin-full")
  const frames = full.body.split("\n\n").filter(Boolean).map((f) => `${f}\n\n`)
  const cut = 3

  test("a reconnect answered 401 asks for a fresh token and retries with it", async () => {
    const rejoined = loadFixture("memory-rejoin-after-2.0").body
    let token = "old-jwt"
    const asked: boolean[] = []
    const target: RunsTarget = {
      baseUrl: "https://agent.example",
      authToken: "old-jwt",
      getAuthToken: async (refresh) => {
        asked.push(Boolean(refresh))
        if (refresh) token = "new-jwt"
        return token
      },
    }
    const { fetch, calls } = fakeFetch((c, i) => {
      if (i === 0) return sseResponse(frames.slice(0, cut).join(""))
      if (c.headers.Authorization !== "Bearer new-jwt") {
        return new Response(JSON.stringify({ code: "auth", message: "expired" }), { status: 401 })
      }
      return sseResponse(rejoined)
    })
    const stream = await startRun(BODY, { target, fetch, reconnectDelayMs: 1 })
    const items = await drain(stream)
    expect(items.map((i) => i.type)).toEqual(full.items.map((i) => i.event.type))
    expect(calls.map((c) => c.headers.Authorization)).toEqual([
      "Bearer old-jwt",
      "Bearer old-jwt",
      "Bearer new-jwt",
    ])
    expect(asked).toContain(true)
  })

  test("each request reads the current token, not the one the target was resolved with", async () => {
    let token = "jwt-1"
    const target: RunsTarget = {
      baseUrl: "https://agent.example",
      authToken: "jwt-0",
      getAuthToken: async () => token,
    }
    const { fetch, calls } = fakeFetch(() => runJson("running"))
    await getRun(RUN, { target, fetch })
    token = "jwt-2"
    await cancelRun(RUN, { target, fetch })
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer jwt-1", "Bearer jwt-2"])
  })

  test("a second 401 after the refresh surfaces (no retry loop)", async () => {
    let refreshes = 0
    const target: RunsTarget = {
      baseUrl: "https://agent.example",
      authToken: "jwt",
      getAuthToken: async (refresh) => {
        if (refresh) refreshes += 1
        return "jwt"
      },
    }
    const { fetch, calls } = fakeFetch(
      () => new Response(JSON.stringify({ code: "auth", message: "no" }), { status: 401 }),
    )
    const err = await getRun(RUN, { target, fetch }).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: "http", status: 401 })
    expect(refreshes).toBe(1)
    expect(calls).toHaveLength(2)
  })
})

describe("rejoinRun / getRun / cancelRun", () => {
  test("rejoin sends the cursor as ?after= and Last-Event-ID, with the stored token", async () => {
    const tokens = memoryStorage()
    saveRunToken(RUN, TOKEN, tokens)
    const { fetch, calls } = fakeFetch(() => sseResponse(loadFixture("memory-rejoin-after-2").body))
    const stream = await rejoinRun(RUN, { target: ANON, fetch, tokens, after: "2" })
    expect(stream.cursor).toBe("2")
    await drain(stream)
    expect(calls[0]).toMatchObject({
      url: `/v1/runs/${RUN}/events?after=2`,
      method: "GET",
      headers: { "Last-Event-ID": "2", "X-Run-Token": TOKEN },
    })
  })

  test("rejoin from 0 sends no cursor; a malformed cursor is refused", async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse(loadFixture("memory-rejoin-full").body))
    await drain(await rejoinRun(RUN, { target: SIGNED_IN, fetch }))
    expect(calls[0].url).toBe(`https://agent.example/v1/runs/${RUN}/events`)
    expect(calls[0].headers["Last-Event-ID"]).toBeUndefined()
    await expect(rejoinRun(RUN, { target: SIGNED_IN, fetch, after: "1.x" })).rejects.toMatchObject({
      kind: "protocol",
    })
  })

  test("status and cancel; a terminal anonymous run's token is dropped, an interrupted one's kept", async () => {
    const tokens = memoryStorage()
    saveRunToken(RUN, TOKEN, tokens)
    let { fetch, calls } = fakeFetch(() => runJson("interrupted"))
    expect((await getRun(RUN, { target: ANON, fetch, tokens })).status).toBe("interrupted")
    expect(calls[0]).toMatchObject({ url: `/v1/runs/${RUN}`, method: "GET", headers: { "X-Run-Token": TOKEN } })
    expect(loadRunToken(RUN, tokens)).toBe(TOKEN)
    ;({ fetch, calls } = fakeFetch(() => runJson("cancelled")))
    expect((await cancelRun(RUN, { target: ANON, fetch, tokens })).status).toBe("cancelled")
    expect(calls[0]).toMatchObject({ url: `/v1/runs/${RUN}/cancel`, method: "POST" })
    expect(loadRunToken(RUN, tokens)).toBeNull()
  })

  test("404 throws not_found and forgets the token", async () => {
    const tokens = memoryStorage()
    saveRunToken(RUN, TOKEN, tokens)
    const { fetch } = fakeFetch(
      () => new Response(JSON.stringify({ code: "not_found", message: "no" }), { status: 404 }),
    )
    await expect(getRun(RUN, { target: ANON, fetch, tokens })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    })
    expect(loadRunToken(RUN, tokens)).toBeNull()
  })
})
