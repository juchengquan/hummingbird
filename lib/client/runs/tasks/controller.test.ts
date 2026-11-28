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
import { TASK_RESULT_NAMESPACE, resultIdsFor, uuidV5 } from "@/shared/runs/ids"

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

  test("runCode's files go by id only: a background run mounts cloud files (Q93)", async () => {
    const server = new FakeRunsServer()
    const t = tab({ server })
    await t.controller.launch(
      {
        ...INPUT,
        skills: [{ id: "codeInterpreter" }],
        // A stray `dataBase64` (not in the schema) never goes.
        sandboxFiles: [{ name: "cloud.csv", fileId: "f1", dataBase64: "YQ==" } as { name: string; fileId: string }],
      },
      { title: "Plot" },
    )
    const body = server.calls.find((c) => c.op === "start")!.arg as { forwardedProps: Record<string, unknown> }
    expect(body.forwardedProps.sandboxFiles).toEqual([{ name: "cloud.csv", fileId: "f1" }])
    // None to mount → no key.
    await t.controller.launch(INPUT, { title: "Plain" })
    const plain = server.calls.filter((c) => c.op === "start")[1].arg as { forwardedProps: Record<string, unknown> }
    expect(plain.forwardedProps.sandboxFiles).toBeUndefined()
    expect(body.forwardedProps.skills).toEqual([{ id: "codeInterpreter" }])
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

  test("a list read before the start landed, answering after it: the accepted start isn't sent again", async () => {
    const server = new FakeRunsServer()
    const api = server.api()
    let releaseList!: () => void
    const listHeld = new Promise<void>((resolve) => (releaseList = resolve))
    let heldOnce = false
    const t = tab({
      server,
      overrides: {
        api: {
          ...api,
          list: async (query) => {
            // Read now (no run yet), answered only once the start is accepted.
            const page = await api.list(query)
            if (!heldOnce) {
              heldOnce = true
              await listHeld
            }
            return page
          },
        },
      },
    })
    const reading = t.controller.refreshNow()
    const res = await t.controller.launch(INPUT)
    expect(res.ok).toBe(true)
    releaseList()
    await reading
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(server.calls.filter((c) => c.op === "start")).toHaveLength(1)
    // The next read lists it: no longer launching.
    await t.controller.refreshNow()
    expect(t.pointers.launching()).toEqual([])
  })

  test("signed out: refused before anything is kept", async () => {
    const server = new FakeRunsServer()
    for (const [availability, code] of [
      [{ ok: false, reason: "signed_out" }, "auth_required"],
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

describe("only signed in", () => {
  test("signed out: no list read, no delivery, no notification", async () => {
    const server = new FakeRunsServer()
    server.add(makeRun({ id: "00000000-0000-4000-8000-0000000000e1", status: "succeeded", result: { text: "x" } }))
    const t = tab({ server, overrides: { availability: () => ({ ok: false, reason: "signed_out" }) } })
    t.store.addConversation("4738a0ca-220f-43ff-b1c6-a75aa9265be1")
    t.controller.start()
    await t.controller.refreshNow()
    await new Promise((r) => setTimeout(r, 10))
    expect(server.calls.filter((c) => c.op === "list")).toEqual([])
    expect(server.calls.filter((c) => c.op === "markDelivered")).toEqual([])
    expect(t.store.writes).toBe(0)
    expect(t.shown).toEqual([])
  })

  test("signed in: every task is listed, old-path and scheduled ones included (Q76)", async () => {
    const server = new FakeRunsServer()
    server.add(makeRun({ id: "00000000-0000-4000-8000-0000000000e2", status: "running", goal: "old path" }))
    server.add(makeRun({ id: "00000000-0000-4000-8000-0000000000e3", status: "queued", goal: "scheduled" }))
    const t = tab({ server })
    await t.controller.refreshNow()
    expect(t.controller.snapshot().tasks?.map((x) => x.title).sort()).toEqual(["old path", "scheduled"])
  })
})

describe("a task started the old way, followed on runs (Q126)", () => {
  // The same `tasks` row as any background run: the old `/api/tasks` start
  // and the runs API differ only in the route that created it.
  test("paused and answered through the old respond route: shown as sent, a resume refused 409 run_already_answered", async () => {
    const { server, p0 } = chainServer()
    // A queued `respond` job holds the question (0045).
    server.update(p0, { answerPending: true })
    const t = tab({ server })
    await t.controller.refreshNow()
    const task = t.controller.snapshot().tasks![0]
    expect(task.phase).toBe("answer_sent")
    expect(task.questions[0]).toMatchObject({ answeredBy: "resume", answerPending: true })
    // Another tab still showing the card answers it: the server refuses,
    // and the list is read again.
    server.nextResumeError = new RunsError("http", "run_already_answered", "Answered already.", 409)
    const lists = server.calls.filter((c) => c.op === "list").length
    const res = await t.controller.answer(task.questions[0], { value: "red" })
    expect(res).toEqual({ ok: false, code: "run_already_answered", message: "Answered already." })
    await until(() => server.calls.filter((c) => c.op === "list").length > lists)
  })

  test("watched, its sub-agents are read through the runs list (parentRunId), none asking", async () => {
    const manifest = loadBackgroundScenario("spawn")
    const parent = manifest.runs.parent.runId
    const works = manifest.runs["child-works"].runId
    const server = new FakeRunsServer()
    server.add(makeRun({ id: parent, status: "running" }), loadBackgroundFixture("spawn", "parent").items)
    server.add(makeRun({ id: works, rootRunId: parent, parentRunId: parent, status: "running" }))
    const t = tab({ server })
    await t.controller.refreshNow()
    const off = t.controller.subscribeTask(parent, () => {})
    await until(() => (t.controller.getTask(parent)?.children.length ?? 0) > 0)
    expect(t.controller.getTask(parent)!.children.map((c) => c.runId)).toEqual([works])
    expect(server.calls.some((c) => c.op === "list" && (c.arg as { parentRunId?: string }).parentRunId === parent)).toBe(true)
    off()
  })

  test("the old respond job's answer applied: the task carries on in its own run, watched from its full log", async () => {
    const { server, p0 } = chainServer()
    const t = tab({ server })
    await t.controller.refreshNow()
    const off = t.controller.subscribeTask(p0, () => {})
    await until(() => t.controller.getTask(p0)?.connection === "closed")
    // The worker took the old route's answer: the same run goes on (no
    // resume run), its log grows past the interrupt.
    server.update(p0, { status: "succeeded", openInterrupts: [], result: { text: "Done the old way." } })
    await t.controller.refreshNow()
    const task = t.controller.getTask(p0)!
    expect(task.currentRunId).toBe(p0)
    expect(task.phase).toBe("succeeded")
    expect(task.questions).toEqual([])
    expect(server.calls.some((c) => c.op === "resume")).toBe(false)
    off()
  })

  test("finished while away and never marked delivered: delivered here under the task's ids, once", async () => {
    const server = new FakeRunsServer()
    const root = "00000000-0000-4000-8000-0000000000e9"
    server.add(makeRun({ id: root, threadId: CONV, status: "succeeded", result: { text: "Old answer." } }))
    const t = tab({ server })
    t.store.addConversation(CONV)
    // The old path already wrote it under the same derived id (Q70).
    t.store.addMessageWithId(resultIdsFor(USER, root).messageId, { role: "assistant", content: "Old answer." } as never, CONV)
    const before = t.store.writes
    await t.controller.refreshNow()
    await until(() => server.marks.size === 1)
    expect(t.store.writes).toBe(before)
    expect(t.store.conversations.get(CONV)!.messages).toHaveLength(1)
  })
})

describe("delivery output", () => {
  test("an unwatched task's images are read from its chain and stored on the delivered message", async () => {
    const { loadFixture } = await import("../fixtures")
    const server = new FakeRunsServer()
    const root = "00000000-0000-4000-8000-0000000000f7"
    server.add(
      makeRun({ id: root, threadId: CONV, status: "succeeded", result: { text: "A fox." } }),
      loadFixture("memory-generated-image").items,
    )
    const t = tab({ server })
    t.store.addConversation(CONV)
    await t.controller.refreshNow()
    await until(() => server.marks.size === 1)
    const message = t.store.conversations.get(CONV)!.messages[0] as { generatedImages?: Array<{ id: string; storagePath?: string }> }
    expect(message.generatedImages?.map((i) => [i.id, i.storagePath])).toEqual([["c-img-0", "u/generated/fox.png"]])
  })

  test("a 0.5.1 task's images come from getRun (the list leaves them out), with no stream read (Q87)", async () => {
    const server = new FakeRunsServer()
    const root = "00000000-0000-4000-8000-0000000000f8"
    const image = {
      id: "kid-img-0",
      url: "https://signed.test/kid.png",
      storagePath: "u/generated/kid.png",
      width: 1,
      height: 1,
      format: "png",
      prompt: "a cat",
      mode: "t2i",
    }
    server.add(makeRun({ id: root, threadId: CONV, status: "succeeded", result: { text: "Drew.", images: [image] } }))
    const t = tab({ server })
    t.store.addConversation(CONV)
    await t.controller.refreshNow()
    await until(() => server.marks.size === 1)
    const message = t.store.conversations.get(CONV)!.messages[0] as { generatedImages?: unknown[] }
    expect(message.generatedImages).toEqual([image])
    expect(server.calls.filter((c) => c.op === "stream")).toEqual([])
    expect(server.calls.filter((c) => c.op === "get").map((c) => c.arg)).toEqual([root])
  })

  test("a 0.5.2 task's code output is delivered as a chat turn stores it (Q94)", async () => {
    const server = new FakeRunsServer()
    const root = "00000000-0000-4000-8000-0000000000fa"
    const chart = { id: "c1-0", url: "data:image/png;base64,UE5H", width: 0, height: 0, format: "png", prompt: "", mode: "code" }
    const file = { id: "c1-file-0", name: "out.csv", sizeBytes: 4, mimeType: "text/csv", url: "data:text/csv;base64,YQoxCg==" }
    const code = { id: "c1", stdout: "42\n", stderr: "", results: [{ type: "table", columns: ["a"], rows: [["1"]] }] }
    server.add(
      makeRun({
        id: root,
        threadId: CONV,
        status: "succeeded",
        result: { text: "It is 42.", images: [chart], files: [file], codeResults: [code] },
      }),
    )
    const t = tab({ server })
    t.store.addConversation(CONV)
    await t.controller.refreshNow()
    await until(() => server.marks.size === 1)
    const message = t.store.conversations.get(CONV)!.messages[0] as Record<string, unknown>
    // A chart is a gallery image, as chat stores it (mode t2i, no prompt).
    expect(message.generatedImages).toEqual([{ ...chart, mode: "t2i" }])
    expect(message.generatedFiles).toEqual([{ ...file, storagePath: null }])
    expect(message.codeResults).toEqual([code])
    // The file is saved as a `file` artifact too, under a derived id.
    const [artifact] = [...t.store.artifacts.values()]
    expect(artifact).toMatchObject({ conversationId: CONV, messageId: message.id, kind: "file", title: "out.csv", content: "" })
    expect(artifact.storagePath).toBe(file.url)
    expect(artifact.id).toBe(uuidV5(TASK_RESULT_NAMESPACE, `task-result:file:${USER}:${root}:c1-file-0`))
    expect(server.calls.filter((c) => c.op === "stream")).toEqual([])
  })

  test("a 0.5.1 task with no images reads no stream either", async () => {
    const server = new FakeRunsServer()
    const root = "00000000-0000-4000-8000-0000000000f9"
    server.add(makeRun({ id: root, threadId: CONV, status: "succeeded", result: { text: "Plain.", images: [] } }))
    const t = tab({ server })
    t.store.addConversation(CONV)
    await t.controller.refreshNow()
    await until(() => server.marks.size === 1)
    const message = t.store.conversations.get(CONV)!.messages[0] as { generatedImages?: unknown[] }
    expect(message.generatedImages).toBeUndefined()
    expect(server.calls.filter((c) => c.op === "stream")).toEqual([])
  })
})
