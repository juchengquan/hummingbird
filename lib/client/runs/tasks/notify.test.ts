/**
 * Task notifications (Q74): once per event across tabs, hidden tabs only,
 * one tag per task; questions (own and a sub-agent's), failures and
 * finishes; never a week of old events on opening.
 */
import { describe, expect, test } from "bun:test"

import { notificationEvents, notificationTag, notifyOnce, NOTIFY_WINDOW_MS, type NotifyDeps } from "./notify"
import { TaskPointers } from "./pointers"
import { summaryOf } from "./summary"
import { FakeRunsServer, USER, advanceClock, browser, makeRun, nowIso, tab, type Browser } from "./test-support"

function deps(b: Browser, hidden: boolean, shown: Array<{ title: string; tag: string }>): NotifyDeps {
  return {
    userId: USER,
    pointers: new TaskPointers(USER, b.storage),
    locks: b.locks,
    now: () => Date.parse(nowIso()),
    isHidden: () => hidden,
    permission: () => "granted",
    show: (title, o) => shown.push({ title, tag: o.tag }),
  }
}

const ROOT_A = "aaaaaaaa-0000-4000-8000-000000000001"
const ROOT_B = "bbbbbbbb-0000-4000-8000-000000000002"

describe("notifications", () => {
  test("one event, two hidden tabs: shown once", async () => {
    const b = browser()
    const shown: Array<{ title: string; tag: string }> = []
    const task = summaryOf(
      makeRun({ id: ROOT_A, status: "succeeded", result: { text: "ok" }, finishedAt: nowIso() }),
      { userId: USER },
    )
    const [event] = notificationEvents(task)
    const results = await Promise.all([notifyOnce(event, deps(b, true, shown)), notifyOnce(event, deps(b, true, shown))])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(shown).toEqual([{ title: "Task finished · Paint it", tag: notificationTag(ROOT_A) }])
    // Read again later: still once.
    expect(await notifyOnce(event, deps(b, true, shown))).toBe(false)
    expect(shown).toHaveLength(1)
  })

  test("a visible tab marks it without showing; a hidden tab then shows nothing", async () => {
    const b = browser()
    const shown: Array<{ title: string; tag: string }> = []
    const task = summaryOf(makeRun({ id: ROOT_A, status: "failed", error: { code: "x", message: "Broke." }, finishedAt: nowIso() }), {
      userId: USER,
    })
    const [event] = notificationEvents(task)
    expect(await notifyOnce(event, deps(b, false, shown))).toBe(false)
    expect(await notifyOnce(event, deps(b, true, shown))).toBe(false)
    expect(shown).toEqual([])
  })

  test("each task has its own tag; each question its own event", async () => {
    const b = browser()
    const shown: Array<{ title: string; tag: string }> = []
    const asking = (root: string, interruptId: string) =>
      summaryOf(
        makeRun({ id: root, status: "interrupted", openInterrupts: [{ id: interruptId, reason: "input", message: "Colour?" }] as never }),
        { userId: USER },
      )
    for (const t of [asking(ROOT_A, "q1"), asking(ROOT_B, "q1"), asking(ROOT_A, "q2")]) {
      for (const e of notificationEvents(t)) await notifyOnce(e, deps(b, true, shown))
    }
    expect(shown.map((s) => s.tag)).toEqual([notificationTag(ROOT_A), notificationTag(ROOT_B), notificationTag(ROOT_A)])
    expect(shown[0].title).toBe("Task needs your answer · Paint it")
  })

  test("an event older than the window is marked silently", async () => {
    const b = browser()
    const shown: Array<{ title: string; tag: string }> = []
    const old = new Date(Date.parse(nowIso()) - NOTIFY_WINDOW_MS - 1000).toISOString()
    const task = summaryOf(makeRun({ id: ROOT_A, status: "succeeded", result: {}, finishedAt: old }), { userId: USER })
    const [event] = notificationEvents(task)
    expect(await notifyOnce(event, deps(b, true, shown))).toBe(false)
    expect(shown).toEqual([])
    expect(new TaskPointers(USER, b.storage).isNotified(event.key)).toBe(true)
  })

  test("from the list: a sub-agent's question, then the finish — once each across two tabs", async () => {
    const server = new FakeRunsServer()
    const parent = "cccccccc-0000-4000-8000-000000000003"
    const child = "dddddddd-0000-4000-8000-000000000004"
    server.add(makeRun({ id: parent, status: "running", childrenAsking: 1 }))
    server.add(
      makeRun({
        id: child,
        rootRunId: parent,
        parentRunId: parent,
        status: "interrupted",
        openInterrupts: [{ id: "q", reason: "approval" }] as never,
      }),
    )
    const shared = browser()
    const t1 = tab({ server, browser: shared })
    const t2 = tab({ server, browser: shared })
    await Promise.all([t1.controller.refreshNow(), t2.controller.refreshNow()])
    await new Promise((r) => setTimeout(r, 10))
    expect([...t1.shown, ...t2.shown].map((s) => s.title)).toEqual(["Task needs your answer · Paint it"])

    advanceClock(1000)
    server.update(child, { status: "succeeded", openInterrupts: [] })
    server.update(parent, { status: "succeeded", childrenAsking: 0, result: { text: "Done" }, finishedAt: nowIso() })
    await Promise.all([t1.controller.refreshNow(), t2.controller.refreshNow()])
    await new Promise((r) => setTimeout(r, 10))
    await Promise.all([t1.controller.refreshNow(), t2.controller.refreshNow()])
    await new Promise((r) => setTimeout(r, 10))
    expect([...t1.shown, ...t2.shown].map((s) => s.title)).toEqual([
      "Task needs your answer · Paint it",
      "Task finished · Paint it",
    ])
  })
})
