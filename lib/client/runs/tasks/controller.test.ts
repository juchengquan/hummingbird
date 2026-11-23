/**
 * The tasks controller over a fake `/v1/runs` serving agent-py's recorded
 * background streams: launching (the record that survives a lost
 * response), the list (order, phases, sub-agents' questions), watching a
 * chain, answers (a resume, an in-place answer, following the successor
 * after a 409), cancel.
 */
import { describe, expect, test } from "bun:test"

import { RunsError } from "../errors"
import { loadBackgroundFixture, loadBackgroundScenario } from "../fixtures"
import type { TaskRequestInput } from "@/shared/api-schemas"
import { resultIdsFor } from "@/shared/runs/ids"

import { FakeRunsServer, USER, browser, makeRun, tab, until } from "./test-support"

const CONV = "4738a0ca-220f-43ff-b1c6-a75aa9265be1"

const INPUT: TaskRequestInput = {
  conversationId: CONV,
  messages: [{ role: "user", content: "Paint the fence" }],
  model: "anthropic/claude-haiku-4.5",
}

function chainServer() {
  const manifest = loadBackgroundScenario("chain")
  const p0 = manifest.runs.p0.runId
  const r1 = manifest.runs.r1.runId
  const server = new FakeRunsServer()
  const interrupt = (loadBackgroundFixture("chain", "p0").items.at(-1)!.event as unknown as {
    outcome: { interrupts: unknown[] }
  }).outcome.interrupts
  server.add(
    makeRun({ id: p0, status: "interrupted", openInterrupts: interrupt as never, step: 1, finishedAt: new Date().toISOString() }),
    loadBackgroundFixture("chain", "p0").items,
  )
  return { server, p0, r1 }
}

/** Another tab / browser answered P0: R1 holds the question now. */
function answerElsewhere(server: FakeRunsServer, p0: string, r1: string) {
  server.update(p0, { currentRunId: r1 })
  server.add(
    makeRun({ id: r1, rootRunId: p0, previousRunId: p0, status: "succeeded", result: { text: "Painted it blue." } }),
    loadBackgroundFixture("chain", "r1").items,
  )
}

describe("launch", () => {
  test("the run id is kept before the POST: a response lost on the way out is retried with the same id after a reload", async () => {
    const server = new FakeRunsServer()
    const b = browser()
    const first = tab({ server, browser: b })
    server.loseNextStart = "dropped"
    const res = await first.controller.launch(INPUT, { title: "Fence" })
    expect(res.ok).toBe(true)
    const runId = res.ok ? res.rootRunId : ""
    // Kept, and shown as launching.
    expect(first.pointers.launching().map((t) => t.runId)).toEqual([runId])
    expect(first.controller.snapshot().tasks?.map((t) => [t.rootRunId, t.phase])).toEqual([[runId, "launching"]])
    expect(server.runs.size).toBe(0)
    first.controller.dispose()

    // A reload: a new controller over the same storage retries it.
    const second = tab({ server, browser: b })
    await second.controller.refreshNow()
    await until(() => server.runs.has(runId))
    const starts = server.calls.filter((c) => c.op === "start").map((c) => c.arg as { runId: string })
    expect(starts.map((s) => s.runId)).toEqual([runId, runId])
    expect(starts[1]).toEqual(starts[0])
    // Listed now: no longer launching.
    await second.controller.refreshNow()
    expect(second.pointers.launching()).toEqual([])
    expect(second.controller.snapshot().tasks?.map((t) => [t.rootRunId, t.phase])).toEqual([[runId, "queued"]])
  })

  test("a response lost after the server created the run: the retry is idempotent — one task", async () => {
    const server = new FakeRunsServer()
    const t = tab({ server })
    server.loseNextStart = "created"
    const res = await t.controller.launch(INPUT)
    expect(res.ok).toBe(true)
    await t.controller.refreshNow()
    expect(server.runs.size).toBe(1)
    expect(t.pointers.launching()).toEqual([])
  })

  test("a refusal removes the record and reports the code; the board card goes back to To-do", async () => {
    const server = new FakeRunsServer()
    const t = tab({ server })
    t.store.cards.set("card-1", { id: "card-1", title: "Fence", status: "in_progress" })
    const api = server.api()
    const refused = tab({
      server,
      store: t.store,
      overrides: {
        api: {
          ...api,
          start: async () => {
            throw new RunsError("http", "limit_reached", "5 tasks are running.", 409)
          },
        },
      },
    })
    const res = await refused.controller.launch(INPUT, { projectTaskId: "card-1" })
    expect(res).toEqual({ ok: false, code: "limit_reached", message: "5 tasks are running." })
    expect(refused.pointers.launching()).toEqual([])
    expect(t.store.cards.get("card-1")?.status).toBe("todo")
  })

  test("a 404 (conversation not synced yet) waits for the sync queue and retries (bug 5)", async () => {
    const server = new FakeRunsServer()
    const api = server.api()
    let drains = 0
    let tries = 0
    const t = tab({
      server,
      overrides: {
        api: {
          ...api,
          start: async (body) => {
            tries += 1
            if (tries === 1) throw new RunsError("http", "not_found", "no such conversation", 404)
            return api.start(body)
          },
        },
      },
    })
    const deps = (t.controller as unknown as { deps: { launch: { whenDrained: () => Promise<void> } } }).deps
    deps.launch.whenDrained = async () => {
      drains += 1
    }
    const res = await t.controller.launch(INPUT, { projectTaskId: "card-9" })
    expect(res.ok).toBe(true)
    expect(tries).toBe(2)
    expect(drains).toBe(2)
  })

  test("the body: background, images in the message, no attachments, the allow-list, research", async () => {
    const server = new FakeRunsServer()
    const t = tab({ server })
    await t.controller.launch(
      {
        ...INPUT,
        mode: "research",
        allowedMcpServerIds: [],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image", image: "data:image/png;base64,AAAA" },
            ],
          },
        ],
        mcpServers: [{ id: "local-1", name: "l", url: "http://localhost:1", transport: "http" }] as never,
      },
      { title: "Look" },
    )
    const body = server.calls.find((c) => c.op === "start")!.arg as {
      messages: Array<{ role: string; content: unknown }>
      forwardedProps: Record<string, unknown>
      state?: unknown
    }
    expect(body.forwardedProps).toMatchObject({ mode: "background", research: true, allowedMcpServerIds: [], goal: "Look" })
    expect(body.forwardedProps.attachments).toBeUndefined()
    expect(body.forwardedProps.localMcpServers).toBeUndefined()
    expect(body.state).toBeUndefined()
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "data", mimeType: "image/png", value: "AAAA" } },
      { type: "text", text: "What is this?" },
    ])
  })

  test("signed out or not on runs: refused before anything is kept", async () => {
    const server = new FakeRunsServer()
    for (const [availability, code] of [
      [{ ok: false, reason: "signed_out" }, "auth_required"],
      [{ ok: false, reason: "not_runs" }, "not_runs"],
    ] as const) {
      const t = tab({ server, overrides: { availability: () => availability } })
      const res = await t.controller.launch(INPUT)
      expect(res).toMatchObject({ ok: false, code })
      expect(t.pointers.launching()).toEqual([])
    }
    expect(server.calls.filter((c) => c.op === "start")).toEqual([])
  })
})

describe("the list", () => {
  test("needing an answer first, then active, then ended; newest first in each; several at once", async () => {
    const server = new FakeRunsServer()
    server.add(makeRun({ id: "00000000-0000-4000-8000-000000000001", status: "succeeded", result: { text: "a" } }))
    server.add(makeRun({ id: "00000000-0000-4000-8000-000000000002", status: "running" }))
    server.add(makeRun({ id: "00000000-0000-4000-8000-000000000003", status: "running", childrenAsking: 1 }))
    server.add(makeRun({ id: "00000000-0000-4000-8000-000000000004", status: "queued" }))
    server.add(
      makeRun({
        id: "00000000-0000-4000-8000-000000000005",
        status: "interrupted",
        openInterrupts: [{ id: "q", reason: "input", message: "?" }] as never,
      }),
    )
    const t = tab({ server })
    await t.controller.refreshNow()
    const snap = t.controller.snapshot()
    expect(snap.tasks?.map((x) => [x.rootRunId.slice(-1), x.phase])).toEqual([
      ["5", "needs_answer"],
      ["3", "needs_answer"],
      ["4", "queued"],
      ["2", "running"],
      ["1", "succeeded"],
    ])
    expect(snap.activeCount).toBe(4)
    expect(snap.tasks?.[0].resultIds).toEqual(resultIdsFor(USER, "00000000-0000-4000-8000-000000000005"))
  })

  test("a sub-agent's question is read into its parent's row, answered in place", async () => {
    const manifest = loadBackgroundScenario("spawn")
    const parent = manifest.runs.parent.runId
    const child = manifest.runs["child-asks-paused"].runId
    const server = new FakeRunsServer()
    server.add(makeRun({ id: parent, status: "running", childrenAsking: 1 }), loadBackgroundFixture("spawn", "parent").items)
    server.add(
      makeRun({
        id: child,
        rootRunId: parent,
        parentRunId: parent,
        status: "interrupted",
        openInterrupts: [{ id: "q", reason: "input", message: "Which colour?" }] as never,
      }),
    )
    const t = tab({ server })
    await t.controller.refreshNow()
    const task = t.controller.snapshot().tasks![0]
    expect(task.phase).toBe("needs_answer")
    expect(task.questions).toHaveLength(1)
    expect(task.questions[0]).toMatchObject({ runId: child, answeredBy: "in_place", answerPending: false })

    const res = await t.controller.answer(task.questions[0], { value: "blue" })
    expect(res).toEqual({ ok: true })
    expect(server.calls.find((c) => c.op === "answer")?.arg).toEqual({
      runId: child,
      resume: [{ interruptId: "q", status: "resolved", payload: { value: "blue" } }],
    })
    // Sent, not picked up yet: pending, not an open card.
    expect(t.controller.snapshot().tasks![0].phase).toBe("answer_sent")
    await t.controller.refreshNow()
    expect(t.controller.snapshot().tasks![0].phase).toBe("answer_sent")
    expect(t.controller.snapshot().tasks![0].questions[0].answerPending).toBe(true)
  })

  test("a dead branch (a resume that failed before applying) is the note on the reopened question", async () => {
    const { server, p0 } = chainServer()
    server.add(
      makeRun({
        id: "00000000-0000-4000-8000-0000000000dd",
        rootRunId: p0,
        previousRunId: p0,
        currentRunId: p0,
        status: "failed",
        error: { code: "unknown_model", message: "No model." },
      }),
    )
    const t = tab({ server })
    await t.controller.refreshNow()
    const task = t.controller.snapshot().tasks![0]
    expect(task.phase).toBe("needs_answer")
    expect(task.lastAttemptError).toEqual({ code: "unknown_model", message: "No model." })
  })
})

describe("watching and answering a chain", () => {
  test("a resume answers the current run's question; the watch follows the new run", async () => {
    const { server, p0, r1 } = chainServer()
    server.onResume = () => answerElsewhere(server, p0, r1)
    const t = tab({ server })
    await t.controller.refreshNow()
    let changes = 0
    const off = t.controller.subscribeTask(p0, () => (changes += 1))
    await until(() => t.controller.getTask(p0)?.connection === "closed")
    const paused = t.controller.getTask(p0)!
    expect(paused.view.pendingInput?.requestId).toBe("q")
    expect(paused.runIds).toEqual([p0])

    const res = await t.controller.answer(paused.questions[0], { value: "blue" })
    expect(res).toEqual({ ok: true })
    const resume = server.calls.find((c) => c.op === "resume")!.arg as { previousRunId: string; resume: unknown }
    expect(resume).toMatchObject({
      previousRunId: p0,
      resume: [{ interruptId: "q", status: "resolved", payload: { value: "blue" } }],
    })
    await until(() => t.controller.getTask(p0)?.view.text === "Painted it blue.")
    const done = t.controller.getTask(p0)!
    expect(done.currentRunId).toBe(r1)
    expect(done.runIds).toEqual([p0, r1])
    expect(done.view.status).toBe("done")
    expect(done.view.toolCalls[0]).toMatchObject({ toolCallId: "q", summary: "blue", status: "done" })
    expect(changes).toBeGreaterThan(0)
    off()
  })

  test("409 run_already_resumed: the list is read again and the watch follows the successor", async () => {
    const { server, p0, r1 } = chainServer()
    const t = tab({ server })
    await t.controller.refreshNow()
    const off = t.controller.subscribeTask(p0, () => {})
    await until(() => t.controller.getTask(p0)?.connection === "closed")
    const question = t.controller.getTask(p0)!.questions[0]
    // Another tab answered meanwhile.
    answerElsewhere(server, p0, r1)
    server.nextResumeError = new RunsError("http", "run_already_resumed", "Answered already.", 409)
    const res = await t.controller.answer(question, { value: "red" })
    expect(res).toEqual({ ok: false, code: "run_already_resumed", message: "Answered already." })
    await until(() => t.controller.getTask(p0)?.view.text === "Painted it blue.")
    const task = t.controller.getTask(p0)!
    expect(task.currentRunId).toBe(r1)
    expect(task.phase).toBe("succeeded")
    expect(task.questions).toEqual([])
    off()
  })

  test("getTask returns the same object until the task changes", async () => {
    const { server, p0 } = chainServer()
    const t = tab({ server })
    await t.controller.refreshNow()
    const a = t.controller.getTask(p0)
    expect(t.controller.getTask(p0)).toBe(a)
    expect(t.controller.getTask("nope")).toBeNull()
  })

  test("cancel cancels the task's current run", async () => {
    const { server, p0 } = chainServer()
    const t = tab({ server })
    await t.controller.refreshNow()
    await t.controller.cancel(p0)
    expect(server.calls.filter((c) => c.op === "cancel").map((c) => c.arg)).toEqual([p0])
    expect(t.controller.snapshot().tasks![0].phase).toBe("cancelled")
  })
})
