/**
 * The runs operations (tag `runs`): `startRun`, `listRuns`, `getRun`,
 * `streamRunEvents`, `cancelRun` — beyond the generic auth / error
 * cases. See ../README.md ("What the runs conformance cases cover") and
 * RUN_EVENTS.md (streams, cursor, gap).
 *
 * Cases that start runs need a backend whose harness is model-free
 * (`CONTRACT_RUNS_STUB=1`; agent-py: `RUNS_STUB_HARNESS=true`). The stub
 * is steered per run through `forwardedProps.conformance`:
 * `{ outcome?: "succeed" | "fail" | "interrupt", steps?: 1..20,
 *    stepDelayMs?: 0..10000 }` — an interrupted stub run raises one
 * `approval` interrupt; a run answering it succeeds.
 *
 * Signed-in cases need `CONTRACT_AUTH_TOKEN`; cross-user cases also
 * `CONTRACT_AUTH_TOKEN_2`; the background 202 case `CONTRACT_THREAD_ID`
 * (a conversation the first user owns); the compacted-replay case
 * `CONTRACT_COMPACTED_RUN_ID`.
 */
import { randomUUID } from "node:crypto"

import { beforeAll, describe, expect, test } from "bun:test"
import type { ValidateFunction } from "ajv/dist/2020"

import {
  call,
  callSse,
  Contract,
  createAjv,
  env,
  type Exchange,
  type SseExchange,
  type SseMessage,
} from "./harness"

const TIMEOUT = 30_000

type Json = Record<string, unknown>
type AgUiEvent = Json & { type: string }

interface RunBodyOptions {
  runId?: string
  threadId?: string
  mode?: "interactive" | "background"
  conformance?: { outcome?: "succeed" | "fail" | "interrupt"; steps?: number; stepDelayMs?: number }
  resume?: Json[]
  previousRunId?: string
  model?: string
  text?: string
}

function runBody(o: RunBodyOptions = {}): Json {
  const forwardedProps: Json = {}
  if (o.mode) forwardedProps.mode = o.mode
  if (o.conformance) forwardedProps.conformance = o.conformance
  if (o.previousRunId) forwardedProps.previousRunId = o.previousRunId
  if (o.model) forwardedProps.model = o.model
  if (o.mode === "background") Object.assign(forwardedProps, { goal: "Conformance probe", maxSteps: 1 })
  const body: Json = {
    threadId: o.threadId ?? randomUUID(),
    runId: o.runId ?? randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: o.text ?? "Conformance probe: say hi." }],
  }
  if (Object.keys(forwardedProps).length > 0) body.forwardedProps = forwardedProps
  if (o.resume) body.resume = o.resume
  return body
}

function randomRunToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")
}

/** `[seq, k]` of a cursor id; plain `s` sorts after every `s.k`. */
function cursorKey(id: string): [number, number] {
  const [seq, k] = id.split(".")
  return [Number(seq), k === undefined ? Number.POSITIVE_INFINITY : Number(k)]
}

function cursorLess(a: string, b: string): boolean {
  const [as, ak] = cursorKey(a)
  const [bs, bk] = cursorKey(b)
  return as < bs || (as === bs && ak < bk)
}

function code(ex: Exchange): unknown {
  return (ex.body as { code?: unknown } | undefined)?.code
}

describe.skipIf(!env.baseUrl)(`conformance: runs @ ${env.baseUrl}`, () => {
  let contract: Contract
  let validateEvent: ValidateFunction
  let validateGap: ValidateFunction
  let validateRunToken: ValidateFunction

  beforeAll(async () => {
    contract = await Contract.load()
    const ajv = createAjv()
    const sse = contract.operation("startRun").raw.responses["200"]?.content?.["text/event-stream"]
    validateEvent = ajv.compile(sse!.schema!)
    validateGap = ajv.compile(contract.schema("RunGapEventValue"))
    validateRunToken = ajv.compile(contract.schema("RunToken"))
  })

  const op = (id: string) => contract.operation(id)

  /**
   * Check a run stream's framing (RUN_EVENTS.md § 6.1) and return its
   * events: valid AG-UI events; `RUN_STARTED` first (matching ids, no
   * SSE id); `RUN_FINISHED` / `RUN_ERROR` last (no id); every other event
   * bar a `gap` (and a purged run's empty snapshot) has a `RunCursor` id,
   * strictly increasing.
   */
  function assertRunStream(
    ex: SseExchange,
    ids: { runId: string; threadId: string },
  ): { events: AgUiEvent[]; messages: SseMessage[] } {
    expect(ex.status).toBe(200)
    expect(ex.contentType).toContain("text/event-stream")
    const events = ex.messages.map((m) => JSON.parse(m.data) as AgUiEvent)
    for (const [i, event] of events.entries()) {
      if (!validateEvent(event)) {
        throw new Error(`event ${i} is not an AG-UI Event: ${JSON.stringify(event)}`)
      }
    }
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[0]).toMatchObject({ type: "RUN_STARTED", runId: ids.runId, threadId: ids.threadId })
    expect(ex.messages[0]!.id).toBeNull()
    const last = events.at(-1)!
    expect(["RUN_FINISHED", "RUN_ERROR"]).toContain(last.type)
    expect(ex.messages.at(-1)!.id).toBeNull()
    let previous: string | null = null
    for (let i = 1; i < events.length - 1; i++) {
      const event = events[i]!
      const id = ex.messages[i]!.id
      if (event.type === "CUSTOM" && event.name === "hummingbird.gap") {
        expect(id).toBeNull()
        if (!validateGap(event.value)) throw new Error(`gap value invalid: ${JSON.stringify(event.value)}`)
        expect(events[i + 1]?.type).toBe("MESSAGES_SNAPSHOT")
        continue
      }
      if (id === null && event.type === "MESSAGES_SNAPSHOT" && events[i - 1]?.name === "hummingbird.gap") continue
      expect(id).toMatch(/^(0|[1-9][0-9]{0,9})(\.(0|[1-9][0-9]{0,3}))?$/)
      if (previous !== null) expect(cursorLess(previous, id!)).toBe(true)
      previous = id
    }
    return { events, messages: ex.messages }
  }

  async function startInteractive(o: RunBodyOptions & { token?: string | null; runToken?: string } = {}) {
    const body = runBody(o)
    const headers: Record<string, string> = {}
    if (o.runToken) headers["x-run-token"] = o.runToken
    const ex = await callSse(op("startRun"), { body, token: o.token, headers })
    return { ex, body, runId: body.runId as string, threadId: body.threadId as string }
  }

  /** `getRun` + the status ↔ result / error / openInterrupts rule. */
  async function getRun(runId: string, auth: { token?: string | null; runToken?: string }): Promise<Json> {
    const ex = await call(op("getRun"), {
      token: auth.token,
      headers: auth.runToken ? { "x-run-token": auth.runToken } : {},
      pathParams: { runId },
    })
    expect(ex.status).toBe(200)
    contract.assertConforms("getRun", ex)
    const run = ex.body as Json
    assertStatusRule(run)
    return run
  }

  function assertStatusRule(run: Json) {
    const status = run.status as string
    expect(run.result === null).toBe(status !== "succeeded")
    expect(run.error === null).toBe(status !== "failed")
    expect((run.openInterrupts as unknown[]).length > 0).toBe(status === "interrupted")
    expect(run.finishedAt === null).toBe(["queued", "running"].includes(status))
  }

  // --- validation (no run is started) ------------------------------------------

  describe("validation", () => {
    test("non-UUID runId / threadId → 422 invalid_request", async () => {
      for (const body of [
        { ...runBody(), runId: "run-1" },
        { ...runBody(), threadId: "thread-1" },
      ]) {
        const ex = await call(op("startRun"), { body })
        expect(ex.status).toBe(422)
        contract.assertConforms("startRun", ex)
        expect(code(ex)).toBe("invalid_request")
      }
    })

    test("resume[] without forwardedProps.previousRunId → 400 invalid_request", async () => {
      const body = runBody({ resume: [{ interruptId: "x", status: "cancelled" }] })
      const ex = await call(op("startRun"), { body })
      expect(ex.status).toBe(400)
      contract.assertConforms("startRun", ex)
      expect(code(ex)).toBe("invalid_request")
    })

    test("unknown forwardedProps.model → 400 unknown_model, and no run exists", async () => {
      for (const token of env.authToken ? [undefined, env.authToken] : [undefined]) {
        const body = runBody({ model: "conformance/not-a-model" })
        const ex = await call(op("startRun"), { body, token })
        expect(ex.status).toBe(400)
        contract.assertConforms("startRun", ex)
        expect(code(ex)).toBe("unknown_model")
        expect(ex.headers.get("x-run-token")).toBeNull()
        if (token) {
          const run = await call(op("getRun"), { token, pathParams: { runId: body.runId as string } })
          expect(run.status).toBe(404)
        }
      }
    })

    test("anonymous background start → 401 auth_required", async () => {
      const ex = await call(op("startRun"), { body: runBody({ mode: "background" }) })
      expect(ex.status).toBe(401)
      contract.assertConforms("startRun", ex)
      expect(code(ex)).toBe("auth_required")
    })
  })

  // --- credentials on one run ------------------------------------------------------

  describe("credentials", () => {
    test("getRun / streamRunEvents / cancelRun: no credential or a malformed run token → 401", async () => {
      for (const id of ["getRun", "streamRunEvents", "cancelRun"]) {
        const variants: Record<string, string>[] = [
          {},
          { "x-run-token": "short" },
          { "x-run-token": "bad token with spaces!!" },
        ]
        for (const headers of variants) {
          const ex = await call(op(id), { headers, pathParams: { runId: randomUUID() } })
          expect([id, ex.status]).toEqual([id, 401])
          contract.assertConforms(id, ex)
        }
      }
    })

    test("listRuns with only an X-Run-Token → 401", async () => {
      const ex = await call(op("listRuns"), { headers: { "x-run-token": randomRunToken() } })
      expect(ex.status).toBe(401)
      contract.assertConforms("listRuns", ex)
    })

    test("unknown run → the same 404 body from getRun, streamRunEvents and cancelRun", async () => {
      const runId = randomUUID()
      const auths: { token?: string; headers?: Record<string, string> }[] = [
        { headers: { "x-run-token": randomRunToken() } },
      ]
      if (env.authToken) auths.push({ token: env.authToken })
      const bodies = new Set<string>()
      for (const auth of auths) {
        for (const id of ["getRun", "streamRunEvents", "cancelRun"]) {
          const ex = await call(op(id), { ...auth, pathParams: { runId } })
          expect([id, ex.status]).toEqual([id, 404])
          contract.assertConforms(id, ex)
          expect(code(ex)).toBe("not_found")
          bodies.add(ex.text)
        }
      }
      expect(bodies.size).toBe(1)
    })
  })

  // --- runs started on the stub harness ---------------------------------------------

  describe.skipIf(!env.runsStub)("interactive runs (stub harness)", () => {
    test(
      "anonymous start: 200 SSE + X-Run-Token + Location, framed stream, RUN_FINISHED success",
      async () => {
        const { ex, runId, threadId } = await startInteractive({ conformance: { steps: 2 } })
        const { events } = assertRunStream(ex, { runId, threadId })
        expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" })
        const token = ex.headers.get("x-run-token")
        expect(token).not.toBeNull()
        expect(validateRunToken(token)).toBe(true)
        expect(ex.headers.get("location")).toBe(`/v1/runs/${runId}`)

        const run = await getRun(runId, { runToken: token! })
        expect(run).toMatchObject({ id: runId, threadId, mode: "interactive", status: "succeeded" })
        expect(run.lastSeq as number).toBeGreaterThan(0)
      },
      TIMEOUT,
    )

    test.skipIf(!env.authToken)(
      "signed-in start: no X-Run-Token; getRun succeeded with its result",
      async () => {
        const { ex, runId, threadId } = await startInteractive({ token: env.authToken })
        assertRunStream(ex, { runId, threadId })
        expect(ex.headers.get("x-run-token")).toBeNull()
        const run = await getRun(runId, { token: env.authToken })
        expect(run.status).toBe("succeeded")
        expect(run.result).not.toBeNull()
      },
      TIMEOUT,
    )

    test(
      "failed run: stream ends with RUN_ERROR; getRun failed with its error",
      async () => {
        const { ex, runId, threadId } = await startInteractive({ conformance: { outcome: "fail" } })
        const { events } = assertRunStream(ex, { runId, threadId })
        expect(events.at(-1)!.type).toBe("RUN_ERROR")
        const run = await getRun(runId, { runToken: ex.headers.get("x-run-token")! })
        expect(run.status).toBe("failed")
        expect((run.error as Json).code).toBe((events.at(-1) as Json).code)
      },
      TIMEOUT,
    )

    test(
      "idempotent retry: the same body (with its run token) replays the same stream",
      async () => {
        const first = await startInteractive({ conformance: { steps: 3 } })
        const a = assertRunStream(first.ex, first)
        const token = first.ex.headers.get("x-run-token")!
        const again = await callSse(op("startRun"), { body: first.body, headers: { "x-run-token": token } })
        const b = assertRunStream(again, first)
        expect(b.messages).toEqual(a.messages)
        expect(again.headers.get("x-run-token")).toBe(token)
      },
      TIMEOUT,
    )

    test.skipIf(!env.authToken)(
      "idempotent retry, signed in: one run, the second call replays from 0",
      async () => {
        const first = await startInteractive({ token: env.authToken, conformance: { steps: 2 } })
        const a = assertRunStream(first.ex, first)
        const again = await callSse(op("startRun"), { body: first.body, token: env.authToken })
        const b = assertRunStream(again, first)
        expect(b.messages).toEqual(a.messages)
      },
      TIMEOUT,
    )

    test(
      "a taken runId → 409 run_id_conflict, one body for every case",
      async () => {
        const anon = await startInteractive()
        assertRunStream(anon.ex, anon)
        const conflicts: Exchange[] = [
          // an anonymous run without its token
          await call(op("startRun"), { body: anon.body }),
          // with its token, but on another thread
          await call(op("startRun"), {
            body: { ...anon.body, threadId: randomUUID() },
            headers: { "x-run-token": anon.ex.headers.get("x-run-token")! },
          }),
        ]
        if (env.authToken) {
          // a signed-in user reusing an anonymous run's id
          conflicts.push(await call(op("startRun"), { body: anon.body, token: env.authToken }))
          const mine = await startInteractive({ token: env.authToken })
          assertRunStream(mine.ex, mine)
          // own run, other thread / other mode
          conflicts.push(
            await call(op("startRun"), { body: { ...mine.body, threadId: randomUUID() }, token: env.authToken }),
            await call(op("startRun"), {
              body: runBody({ runId: mine.runId, threadId: mine.threadId, mode: "background" }),
              token: env.authToken,
            }),
          )
          if (env.authToken2) {
            conflicts.push(await call(op("startRun"), { body: mine.body, token: env.authToken2 }))
          }
        }
        const bodies = new Set<string>()
        for (const ex of conflicts) {
          expect(ex.status).toBe(409)
          contract.assertConforms("startRun", ex)
          expect(code(ex)).toBe("run_id_conflict")
          bodies.add(ex.text)
        }
        expect(bodies.size).toBe(1)
      },
      TIMEOUT,
    )

    test(
      "anonymous run token scoping: its token → 200; another token → 404; none → 401",
      async () => {
        const { ex, runId } = await startInteractive()
        expect(ex.status).toBe(200)
        const token = ex.headers.get("x-run-token")!
        for (const id of ["getRun", "streamRunEvents", "cancelRun"]) {
          const mine =
            id === "streamRunEvents"
              ? await callSse(op(id), { headers: { "x-run-token": token }, pathParams: { runId } })
              : await call(op(id), { headers: { "x-run-token": token }, pathParams: { runId } })
          expect([id, mine.status]).toEqual([id, 200])
          if (id !== "streamRunEvents") contract.assertConforms(id, mine)
          const other = await call(op(id), { headers: { "x-run-token": randomRunToken() }, pathParams: { runId } })
          expect([id, other.status]).toEqual([id, 404])
          contract.assertConforms(id, other)
          const none = await call(op(id), { pathParams: { runId } })
          expect([id, none.status]).toEqual([id, 401])
          contract.assertConforms(id, none)
          if (env.authToken) {
            // a signed-in user is not the owner of an anonymous run
            const user = await call(op(id), { token: env.authToken, pathParams: { runId } })
            expect([id, user.status]).toEqual([id, 404])
          }
        }
      },
      TIMEOUT,
    )

    test(
      "rejoin: after=<cursor> and Last-Event-ID give exactly the events after it",
      async () => {
        const { ex, runId, threadId } = await startInteractive({ conformance: { steps: 3 } })
        const full = assertRunStream(ex, { runId, threadId })
        const headers = { "x-run-token": ex.headers.get("x-run-token")! }
        const replay = await callSse(op("streamRunEvents"), { headers, pathParams: { runId } })
        expect(assertRunStream(replay, { runId, threadId }).messages).toEqual(full.messages)
        const fromZero = await callSse(op("streamRunEvents"), { headers, pathParams: { runId }, query: { after: "0" } })
        expect(fromZero.messages).toEqual(full.messages)

        const withIds = full.messages.map((m, i) => [m, i] as const).filter(([m]) => m.id !== null)
        expect(withIds.length).toBeGreaterThan(2)
        for (const [cut, index] of [withIds[0]!, withIds[Math.floor(withIds.length / 2)]!, withIds.at(-1)!]) {
          const expected = [full.messages[0], ...full.messages.slice(index + 1)]
          const viaQuery = await callSse(op("streamRunEvents"), {
            headers,
            pathParams: { runId },
            query: { after: cut.id! },
          })
          assertRunStream(viaQuery, { runId, threadId })
          expect(viaQuery.messages).toEqual(expected as SseMessage[])
          const viaHeader = await callSse(op("streamRunEvents"), {
            headers: { ...headers, "last-event-id": cut.id! },
            pathParams: { runId },
          })
          expect(viaHeader.messages).toEqual(expected as SseMessage[])
        }
        // `after` wins over Last-Event-ID.
        const both = await callSse(op("streamRunEvents"), {
          headers: { ...headers, "last-event-id": withIds.at(-1)![0].id! },
          pathParams: { runId },
          query: { after: "0" },
        })
        expect(both.messages).toEqual(full.messages)
      },
      TIMEOUT,
    )

    test(
      "rejoin: a malformed or out-of-range cursor → 400 invalid_request",
      async () => {
        const { ex, runId } = await startInteractive()
        expect(ex.status).toBe(200)
        const headers = { "x-run-token": ex.headers.get("x-run-token")! }
        for (const after of ["abc", "1.2.3", "-1", "01", "", "999999"]) {
          const bad = await call(op("streamRunEvents"), { headers, pathParams: { runId }, query: { after } })
          expect([after, bad.status]).toEqual([after, 400])
          contract.assertConforms("streamRunEvents", bad)
          expect(code(bad)).toBe("invalid_request")
        }
        const viaHeader = await call(op("streamRunEvents"), {
          headers: { ...headers, "last-event-id": "nope" },
          pathParams: { runId },
        })
        expect(viaHeader.status).toBe(400)
      },
      TIMEOUT,
    )

    test(
      "cancel: a live run's stream closes with RUN_FINISHED cancelled; cancel is idempotent",
      async () => {
        const body = runBody({ conformance: { steps: 20, stepDelayMs: 250 } })
        const runId = body.runId as string
        const cancels: Exchange[] = []
        const ex = await callSse(op("startRun"), {
          body,
          onMessage: async (_message, index, headers) => {
            if (index !== 1) return
            const auth = { headers: { "x-run-token": headers.get("x-run-token")! }, pathParams: { runId } }
            cancels.push(await call(op("cancelRun"), auth), await call(op("cancelRun"), auth))
          },
        })
        const { events } = assertRunStream(ex, { runId, threadId: body.threadId as string })
        expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "cancelled" } })
        expect(cancels.length).toBe(2)
        for (const c of cancels) {
          expect(c.status).toBe(200)
          contract.assertConforms("cancelRun", c)
          expect((c.body as Json).status).toBe("cancelled")
          assertStatusRule(c.body as Json)
        }
        const run = await getRun(runId, { runToken: ex.headers.get("x-run-token")! })
        expect(run.status).toBe("cancelled")
        // A rejoin of the cancelled run closes the same way.
        const rejoin = await callSse(op("streamRunEvents"), {
          headers: { "x-run-token": ex.headers.get("x-run-token")! },
          pathParams: { runId },
        })
        const replayed = assertRunStream(rejoin, { runId, threadId: body.threadId as string })
        expect(replayed.events.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "cancelled" } })
      },
      TIMEOUT,
    )

    test(
      "cancel: a finished run is returned unchanged, every time",
      async () => {
        const { ex, runId, threadId } = await startInteractive()
        assertRunStream(ex, { runId, threadId })
        const token = ex.headers.get("x-run-token")!
        const before = await getRun(runId, { runToken: token })
        expect(before.status).toBe("succeeded")
        const auth = { headers: { "x-run-token": token }, pathParams: { runId } }
        for (const c of [await call(op("cancelRun"), auth), await call(op("cancelRun"), auth)]) {
          expect(c.status).toBe(200)
          contract.assertConforms("cancelRun", c)
          expect(c.body).toEqual(before)
        }
      },
      TIMEOUT,
    )

    test(
      "interrupt + resume (Q24): RUN_FINISHED interrupt; a resume not covering it → 409; an exact one runs",
      async () => {
        const threadId = randomUUID()
        const first = await startInteractive({ threadId, conformance: { outcome: "interrupt" } })
        const { events } = assertRunStream(first.ex, first)
        const closing = events.at(-1) as Json
        expect(closing).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "interrupt" } })
        const interrupts = (closing.outcome as { interrupts: Json[] }).interrupts
        expect(interrupts.length).toBeGreaterThan(0)
        const token = first.ex.headers.get("x-run-token")!
        const run = await getRun(first.runId, { runToken: token })
        expect(run.status).toBe("interrupted")
        expect(run.openInterrupts).toEqual(interrupts)

        const auth = { headers: { "x-run-token": token } }
        for (const resume of [
          [{ interruptId: "not-an-open-interrupt", status: "cancelled" }],
          [],
          [...interrupts.map((i) => ({ interruptId: i.id, status: "cancelled" })), { interruptId: "extra", status: "cancelled" }],
        ]) {
          const bad = await call(op("startRun"), {
            ...auth,
            body: { ...runBody({ threadId, previousRunId: first.runId }), resume },
          })
          if (resume.length === 0) {
            // An empty resume[] is no resume: previousRunId is ignored, a plain run starts.
            expect(bad.status).toBe(200)
            continue
          }
          expect(bad.status).toBe(409)
          contract.assertConforms("startRun", bad)
          expect(code(bad)).toBe("invalid_state")
        }
        // Another thread → 409 too.
        const otherThread = await call(op("startRun"), {
          ...auth,
          body: runBody({
            previousRunId: first.runId,
            resume: interrupts.map((i) => ({ interruptId: i.id, status: "cancelled" })),
          }),
        })
        expect(otherThread.status).toBe(409)
        expect(code(otherThread)).toBe("invalid_state")

        const answer = await startInteractive({
          threadId,
          runToken: token,
          previousRunId: first.runId,
          resume: interrupts.map((i) => ({ interruptId: i.id, status: "resolved", payload: { approved: true } })),
        })
        const resumed = assertRunStream(answer.ex, answer)
        expect(resumed.events.at(-1)).toMatchObject({ type: "RUN_FINISHED" })
        const newRun = await getRun(answer.runId, { runToken: answer.ex.headers.get("x-run-token")! })
        expect(newRun).toMatchObject({ status: "succeeded", previousRunId: first.runId, threadId })
        // The interrupted run itself never runs again.
        expect((await getRun(first.runId, { runToken: token })).status).toBe("interrupted")
      },
      TIMEOUT,
    )

    test.skipIf(!env.authToken)(
      "status / cancel for a signed-in run; another user's run is the same 404",
      async () => {
        const mine = await startInteractive({ token: env.authToken, conformance: { outcome: "interrupt" } })
        assertRunStream(mine.ex, mine)
        const interrupted = await getRun(mine.runId, { token: env.authToken })
        expect(interrupted.status).toBe("interrupted")
        const c1 = await call(op("cancelRun"), { token: env.authToken, pathParams: { runId: mine.runId } })
        const c2 = await call(op("cancelRun"), { token: env.authToken, pathParams: { runId: mine.runId } })
        for (const c of [c1, c2]) {
          expect(c.status).toBe(200)
          contract.assertConforms("cancelRun", c)
          expect(c.body).toMatchObject({ status: "cancelled", openInterrupts: [] })
          assertStatusRule(c.body as Json)
        }
        if (env.authToken2) {
          const bodies = new Set<string>()
          for (const id of ["getRun", "streamRunEvents", "cancelRun"]) {
            for (const runId of [mine.runId, randomUUID()]) {
              const ex = await call(op(id), { token: env.authToken2, pathParams: { runId } })
              expect([id, ex.status]).toEqual([id, 404])
              contract.assertConforms(id, ex)
              bodies.add(ex.text)
            }
          }
          expect(bodies.size).toBe(1)
        }
      },
      TIMEOUT,
    )

    test.skipIf(!env.authToken)(
      "listRuns: filters, newest first, token paging, bounds, foreign runs never listed",
      async () => {
        const threadId = randomUUID()
        const created: string[] = []
        for (const outcome of ["succeed", "fail", "succeed"] as const) {
          const r = await startInteractive({ token: env.authToken, threadId, conformance: { outcome } })
          assertRunStream(r.ex, r)
          created.push(r.runId)
        }
        const newestFirst = [...created].reverse()
        const list = async (query: Record<string, string | string[]>, token = env.authToken) => {
          const ex = await call(op("listRuns"), { token, query })
          if (ex.status === 200) contract.assertConforms("listRuns", ex)
          return ex
        }
        const all = await list({ threadId })
        expect(all.status).toBe(200)
        const page = all.body as { runs: Json[]; nextPageToken: string | null }
        expect(page.runs.map((r) => r.id)).toEqual(newestFirst)
        expect(page.nextPageToken).toBeNull()
        for (const r of page.runs) assertStatusRule(r)
        const created_at = page.runs.map((r) => Date.parse(r.createdAt as string))
        for (let i = 1; i < created_at.length; i++) expect(created_at[i]!).toBeLessThanOrEqual(created_at[i - 1]!)

        // token paging, one at a time
        const walked: string[] = []
        let pageToken: string | null = null
        for (let i = 0; i < 10; i++) {
          const query: Record<string, string> = { threadId, pageSize: "1" }
          if (pageToken) query.pageToken = pageToken
          const ex = await list(query)
          expect(ex.status).toBe(200)
          const p = ex.body as { runs: Json[]; nextPageToken: string | null }
          walked.push(...p.runs.map((r) => r.id as string))
          pageToken = p.nextPageToken
          if (!pageToken) break
        }
        expect(walked).toEqual(newestFirst)

        // filters
        const ids = async (query: Record<string, string | string[]>) =>
          ((await list(query)).body as { runs: Json[] }).runs.map((r) => r.id)
        expect(await ids({ threadId, status: "failed" })).toEqual([created[1]])
        expect(await ids({ threadId, status: ["succeeded", "failed"] })).toEqual(newestFirst)
        expect(await ids({ threadId, status: "succeeded" })).toEqual([created[2], created[0]])
        expect(await ids({ threadId, mode: "interactive" })).toEqual(newestFirst)
        expect(await ids({ threadId, mode: "background" })).toEqual([])
        expect(await ids({ threadId, parentRunId: randomUUID() })).toEqual([])

        // bounds and bad tokens
        for (const pageSize of ["0", "101"]) {
          const ex = await list({ threadId, pageSize })
          expect([pageSize, ex.status]).toEqual([pageSize, 422])
          contract.assertConforms("listRuns", ex)
          expect(code(ex)).toBe("invalid_request")
        }
        const garbage = await list({ threadId, pageToken: "garbage-token" })
        expect(garbage.status).toBe(400)
        contract.assertConforms("listRuns", garbage)
        expect(code(garbage)).toBe("invalid_request")
        const first = (await list({ threadId, pageSize: "1" })).body as { nextPageToken: string }
        const mismatched = await list({ threadId, mode: "interactive", pageToken: first.nextPageToken })
        expect(mismatched.status).toBe(400)
        contract.assertConforms("listRuns", mismatched)

        if (env.authToken2) {
          const foreign = await list({ threadId }, env.authToken2)
          expect(foreign.status).toBe(200)
          expect((foreign.body as { runs: Json[] }).runs).toEqual([])
        }
      },
      TIMEOUT,
    )
  })

  // --- background runs ---------------------------------------------------------------

  describe.skipIf(!env.authToken)("background runs", () => {
    test("a thread the caller does not own → 404 not_found (503 unavailable without a store)", async () => {
      const ex = await call(op("startRun"), { body: runBody({ mode: "background" }), token: env.authToken })
      contract.assertConforms("startRun", ex)
      if (ex.status === 503) {
        // A backend without a database cannot hold background runs.
        expect(code(ex)).toBe("unavailable")
        return
      }
      expect(ex.status).toBe(404)
      expect(code(ex)).toBe("not_found")
    })

    test.skipIf(!env.threadId)(
      "202 RunAccepted, idempotent retry, getRun queued/running, 409 on another thread",
      async () => {
        const body = runBody({ mode: "background", threadId: env.threadId! })
        const runId = body.runId as string
        const first = await call(op("startRun"), { body, token: env.authToken })
        contract.assertConforms("startRun", first)
        if (first.status === 503) {
          // No store for background runs on this backend (see the case above).
          expect(code(first)).toBe("unavailable")
          return
        }
        expect(first.status).toBe(202)
        expect(first.body).toMatchObject({ runId })
        expect(first.headers.get("location")).toBe(`/v1/runs/${runId}`)
        const again = await call(op("startRun"), { body, token: env.authToken })
        expect(again.status).toBe(202)
        contract.assertConforms("startRun", again)
        expect((again.body as Json).runId).toBe(runId)
        const run = await getRun(runId, { token: env.authToken })
        expect(run.mode).toBe("background")
        expect(["queued", "running"]).toContain(run.status as string)
        const conflict = await call(op("startRun"), {
          body: { ...body, threadId: randomUUID() },
          token: env.authToken,
        })
        expect(conflict.status).toBe(409)
        expect(code(conflict)).toBe("run_id_conflict")
        // clean up: nothing should execute it
        const cancelled = await call(op("cancelRun"), { token: env.authToken, pathParams: { runId } })
        expect(cancelled.status).toBe(200)
        contract.assertConforms("cancelRun", cancelled)
        expect((cancelled.body as Json).status).toBe("cancelled")
      },
      TIMEOUT,
    )
  })

  // --- compaction ----------------------------------------------------------------------

  describe.skipIf(!env.authToken || !env.compactedRunId)("compacted runs", () => {
    test("replay from 0: RUN_STARTED, CUSTOM hummingbird.gap, MESSAGES_SNAPSHOT, …, closing", async () => {
      const runId = env.compactedRunId!
      const run = await getRun(runId, { token: env.authToken })
      const ex = await callSse(op("streamRunEvents"), { token: env.authToken, pathParams: { runId } })
      const { events } = assertRunStream(ex, { runId, threadId: run.threadId as string })
      expect(events[1]).toMatchObject({ type: "CUSTOM", name: "hummingbird.gap" })
      expect(events[2]!.type).toBe("MESSAGES_SNAPSHOT")
    })
  })
})
