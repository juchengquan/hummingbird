import { expect } from "@playwright/test"

import {
  cardStatus,
  childQuestion,
  lastSeqOf,
  launch,
  openApp,
  panel,
  pointer,
  reportCounts,
  rootOf,
  runCard,
  waitSaved,
  seedBoard,
  send,
  test,
} from "./support/tasks"

/** B14: a reload rebuilds the task from its whole log, and repeats nothing. */

test("a queued task reloads as queued and is still watched", async ({ page, tasks }) => {
  await launch(page, tasks, "plain.queued")
  await page.reload()
  await expect(panel(page)).toContainText("Queued")
  await expect(panel(page)).toContainText("/ 25")
  await tasks.stage("plain.done")
  await expect(panel(page)).toContainText("Task finished")
})

test("a running task reloads with its text, plan and step", async ({ page, tasks }) => {
  await launch(page, tasks, "questions.approval")
  const id = rootOf("questions.approval")
  // Past the answered question, mid-step.
  await tasks.stage("questions.choice")
  await tasks.row(id, { status: "running" })
  const last = lastSeqOf("questions.choice")
  await tasks.events([
    { task_id: id, seq: last + 1, step: 2, kind: "approval", payload: { phase: "response", approvalId: "toolu_parent_1", selection: ["blue"] }, created_at: new Date().toISOString() },
    { task_id: id, seq: last + 2, step: 2, kind: "status", payload: { status: "running" }, created_at: new Date().toISOString() },
  ])
  await expect(panel(page)).toContainText("Running")
  await page.reload()
  await expect(panel(page)).toContainText("Checking 1.")
  await expect(panel(page)).toContainText("Checking 2.")
  await expect(panel(page)).toContainText("Gather the facts")
  await expect(panel(page)).toContainText("Step 2 / 25")
  await expect(panel(page)).toContainText("Running")
})

for (const { kind, text } of [
  { kind: "approval", text: "Approve action?" },
  { kind: "choice", text: "Which colour should it be?" },
  { kind: "input", text: "What should the title be?" },
  { kind: "ui-part", text: "Publish the draft now?" },
]) {
  test(`a task paused on ${kind} reloads with its question`, async ({ page, tasks }) => {
    await launch(page, tasks, `questions.${kind}`)
    await page.reload()
    await expect(panel(page)).toContainText(text)
    await expect(panel(page)).toContainText("Paused")
    await expect(panel(page)).toContainText("Gather the facts")
    await expect(panel(page)).toContainText("Checking 1.")
  })
}

test("a task waiting on children reloads with plan, text, children and step", async ({ page, tasks }) => {
  await launch(page, tasks, "children.spawned")
  await page.reload()
  await expect(panel(page)).toContainText("Waiting on sub-agents")
  await expect(panel(page)).toContainText("Gather the facts")
  await expect(panel(page)).toContainText("Delegating.")
  await expect(panel(page)).toContainText("Step 1 / 25")
  await expect(panel(page)).toContainText("input-helper")
  await tasks.stage("children.asking")
  await expect(childQuestion(page, "input")).toBeVisible()
})

test("after a reload the first answer, and the second question, work", async ({ page, tasks }) => {
  await launch(page, tasks, "questions.approval")
  await page.reload()
  await panel(page).getByRole("button", { name: "Reject" }).click()
  await expect.poll(async () => (await tasks.sent("respond")).length).toBe(1)
  await tasks.stage("questions.choice")
  await panel(page).getByRole("radio", { name: "Blue" }).check()
  await panel(page).getByRole("button", { name: "Submit" }).click()
  await expect.poll(async () => (await tasks.sent("respond")).length).toBe(2)
  await tasks.stage("questions.input")
  await expect(panel(page)).toContainText("What should the title be?")
})

test("a paused task is still watched after its stream closes", async ({ page, tasks }) => {
  await launch(page, tasks, "questions.approval")
  await expect(panel(page)).toContainText("Approve action?")
  await tasks.dropStreams()
  await tasks.stage("questions.choice") // answered in another tab
  await expect(panel(page)).toContainText("Which colour should it be?")
})

test("the watch survives a failed reconnect", async ({ page, tasks }) => {
  await launch(page, tasks, "questions.approval")
  await tasks.fault({ op: "stream", status: 500, times: 1 })
  await tasks.dropStreams()
  await tasks.stage("questions.done")
  await expect(panel(page)).toContainText("Task finished")
})

test("a paused task's pointer doesn't expire while it waits", async ({ page, tasks }) => {
  await launch(page, tasks, "questions.approval")
  await expect(panel(page)).toContainText("Approve action?")
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("humm.activeTask")!)
    saved.updatedAt = new Date(Date.now() - 26 * 3600_000).toISOString()
    localStorage.setItem("humm.activeTask", JSON.stringify(saved))
  })
  await page.reload()
  await expect(panel(page)).toContainText("Approve action?")
})

test("a second tab shows the same question", async ({ page, context, tasks }) => {
  await launch(page, tasks, "questions.input")
  await expect(panel(page)).toContainText("What should the title be?")
  const other = await context.newPage()
  await other.goto("/")
  await expect(panel(other)).toContainText("What should the title be?")
})

test.describe("side effects happen once", () => {
  async function research(page: Parameters<typeof openApp>[0], tasks: Parameters<typeof launch>[1]) {
    await tasks.startAs("plain.queued")
    await openApp(page)
    await send(page, "/research Write the report")
    await expect.poll(() => pointer(page)).not.toBeNull()
    await waitSaved(page)
  }
  const ONCE = { messages: 1, documents: 1, artifacts: 1 }

  for (const when of ["before", "during", "after"] as const) {
    test(`a research result, reloaded ${when} completion`, async ({ page, tasks }) => {
      await research(page, tasks)
      if (when === "before") await page.reload()
      if (when === "during") {
        // Hold the result's claim, so the reload lands between the terminal
        // event and what it authors.
        await page.evaluate((name) => {
          void navigator.locks.request(name, () => new Promise(() => {}))
        }, `humm.taskResult.${rootOf("plain.queued")}`)
      }
      await tasks.stage("plain.done")
      await expect(panel(page)).toContainText("Task finished")
      if (when === "during") await page.reload()
      await expect.poll(() => reportCounts(page)).toEqual(ONCE)
      if (when !== "during") await expect(page.getByText("Report opened in the editor")).toHaveCount(1)
      if (when === "after") {
        await page.reload()
        await page.reload()
      }
      await page.waitForTimeout(1500)
      expect(await reportCounts(page)).toEqual(ONCE)
      if (when === "after") await expect(page.getByText("Report opened in the editor")).toHaveCount(0)
    })
  }

  test("a replay of an already delivered result authors nothing", async ({ page, tasks }) => {
    await research(page, tasks)
    const saved = await pointer(page)
    await tasks.stage("plain.done")
    await expect.poll(() => reportCounts(page)).toEqual(ONCE)
    // A crash before the pointer was cleared, or another tab saving it again.
    await page.evaluate((value) => localStorage.setItem("humm.activeTask", value!), saved)
    await page.reload()
    await expect(panel(page)).toContainText("Task finished")
    await page.waitForTimeout(1000)
    expect(await reportCounts(page)).toEqual(ONCE)
    await expect(page.getByText("Report opened in the editor")).toHaveCount(0)
  })

  test("two tabs watching deliver one result", async ({ page, context, tasks }) => {
    await research(page, tasks)
    const other = await context.newPage()
    await other.goto("/")
    await expect(panel(other)).toContainText("Queued")
    await tasks.stage("plain.done")
    await expect(panel(other)).toContainText("Task finished")
    await expect(panel(page)).toContainText("Task finished")
    await page.waitForTimeout(1500)
    expect(await reportCounts(page)).toEqual(ONCE)
  })

  test("the notification and the board's update don't repeat", async ({ page, tasks }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden" })
      class FakeNotification {
        static permission = "granted"
        static requestPermission = async () => "granted"
        constructor() {
          localStorage.setItem("e2e-notified", String(Number(localStorage.getItem("e2e-notified") ?? 0) + 1))
        }
      }
      Object.defineProperty(window, "Notification", { value: FakeNotification })
    })
    await tasks.startAs("plain.queued")
    await openApp(page)
    await seedBoard(page)
    await runCard(page).click()
    await expect.poll(() => pointer(page)).not.toBeNull()
    const saved = await pointer(page)
    await page.reload()
    await tasks.stage("plain.done")
    await expect.poll(() => cardStatus(page)).toBe("done")
    await expect.poll(() => page.evaluate(() => localStorage.getItem("e2e-notified"))).toBe("1")

    await page.evaluate((value) => localStorage.setItem("humm.activeTask", value!), saved)
    await page.reload()
    await expect(panel(page)).toContainText("Task finished")
    await page.waitForTimeout(1000)
    expect(await page.evaluate(() => localStorage.getItem("e2e-notified"))).toBe("1")
    expect((await reportCounts(page)).artifacts).toBe(1)
  })
})
