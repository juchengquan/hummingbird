import { expect } from "@playwright/test"

import {
  cancelButton,
  cardStatus,
  childOf,
  childQuestion,
  DESKTOP,
  launch,
  openApp,
  panel,
  PHONE,
  pointer,
  rootOf,
  runCard,
  seedBoard,
  spinners,
  test,
} from "./support/tasks"

/** Q60, B15, B32: cancel reads as cancelled, and a row that ended says so. */

for (const stage of ["plain.queued", "questions.approval", "children.asking"]) {
  test(`cancel (${stage}): Cancelled at once, nothing spins, the pointer settles`, async ({ page, tasks }) => {
    await launch(page, tasks, stage)
    // A cancel may leave no terminal event in the log.
    await cancelButton(page).click()
    await expect(panel(page)).toContainText("Task cancelled", { timeout: 1500 })
    await expect(spinners(page.locator("body"))).toHaveCount(0)
    await expect.poll(() => pointer(page)).toBeNull()
    expect((await tasks.sent("cancel")).map((s) => s.id)).toEqual([rootOf(stage)])
    await page.reload()
    await expect(panel(page)).not.toContainText(/Queued|Running|Paused/)
  })

  test(`cancel (${stage}) is still offered after a reload`, async ({ page, tasks }) => {
    await launch(page, tasks, stage)
    await page.reload()
    await cancelButton(page).click()
    await expect(panel(page)).toContainText("Task cancelled")
  })

  test(`a failed cancel (${stage}) says so and keeps watching`, async ({ page, tasks }) => {
    await launch(page, tasks, stage)
    await tasks.fault({ op: "cancel", status: 500, body: { code: "provider", message: "Database unavailable." }, times: 1 })
    await cancelButton(page).click()
    await expect(panel(page)).toContainText("Database unavailable.")
    await expect(cancelButton(page)).toBeEnabled()
    await expect(panel(page)).not.toContainText("Task cancelled")
    await tasks.row(rootOf(stage), { status: "cancelled" }) // elsewhere
    await expect(panel(page)).toContainText("Task cancelled")
  })
}

test("cancel is offered on a paused task whose stream closed", async ({ page, tasks }) => {
  await launch(page, tasks, "questions.approval")
  await expect(panel(page)).toContainText("Approve action?")
  await tasks.dropStreams()
  await page.waitForTimeout(700)
  await expect(cancelButton(page)).toBeVisible()
})

test("a cancel that loses to completion shows the real result", async ({ page, tasks }) => {
  await launch(page, tasks, "plain.queued")
  await tasks.fault({ op: "cancel", delayMs: 100 })
  await tasks.fault({ op: "stream", delayMs: 300 })
  await tasks.stage("plain.done")
  await cancelButton(page).click()
  await expect(panel(page)).toContainText("Task finished")
})

test("the board's card settles on cancel", async ({ page, tasks }) => {
  await tasks.startAs("plain.queued")
  await openApp(page)
  await seedBoard(page)
  await runCard(page).click()
  await expect.poll(() => cardStatus(page)).toBe("in_progress")
  await cancelButton(page).click()
  await expect.poll(() => cardStatus(page)).toBe("todo")
  await expect(spinners(page.locator("body"))).toHaveCount(0)
})

for (const status of ["cancelled", "failed", "done"] as const) {
  test(`a row that became ${status} without a terminal event ends the watch`, async ({ page, tasks }) => {
    const id = await launch(page, tasks, "plain.queued")
    await tasks.row(id, { status })
    const label = { cancelled: "Task cancelled", failed: "Task failed", done: "Task finished" }[status]
    await expect(panel(page)).toContainText(label)
    await expect.poll(() => pointer(page)).toBeNull()
    const before = (await tasks.sent("stream")).length
    await page.waitForTimeout(3500)
    expect((await tasks.sent("stream")).length).toBe(before)
  })
}

test("a deleted task ends the watch", async ({ page, tasks }) => {
  const id = await launch(page, tasks, "plain.queued")
  await tasks.row(id, null)
  await expect(panel(page)).toContainText("no longer exists", { timeout: 8000 })
  await expect(spinners(panel(page))).toHaveCount(0)
  await expect.poll(() => pointer(page)).toBeNull()
})

test("a task deleted while the page was closed ends on reload", async ({ page, tasks }) => {
  const id = await launch(page, tasks, "plain.queued")
  await page.goto("about:blank")
  await tasks.row(id, null)
  await page.goto("/")
  await expect(panel(page)).toContainText("no longer exists")
  await expect.poll(() => pointer(page)).toBeNull()
})

test("a cancel in another tab ends this one", async ({ page, context, tasks }) => {
  await launch(page, tasks, "questions.approval")
  const other = await context.newPage()
  await other.goto("/")
  await cancelButton(other).click()
  await expect(panel(other)).toContainText("Task cancelled")
  await expect(panel(page)).toContainText("Task cancelled")
})

for (const [size, viewport] of Object.entries({ desktop: DESKTOP, phone: PHONE })) {
  test(`${size}: a child is skipped from the parent, which keeps going`, async ({ page, tasks }) => {
    await launch(page, tasks, "children.asking")
    await page.setViewportSize(viewport)
    await panel(page).getByRole("button", { name: "Skip sub-agent choice-helper" }).click()
    await expect(childQuestion(page, "choice")).toBeHidden()
    await expect(childQuestion(page, "input")).toBeVisible()
    await expect(panel(page)).not.toContainText("Task cancelled")
    await expect(panel(page)).toContainText("skipped")
    expect((await tasks.sent("cancel")).map((s) => s.id)).toEqual([childOf("choice")])
  })

  test(`${size}: a child is skipped from its window`, async ({ page, tasks }) => {
    await launch(page, tasks, "children.asking")
    await page.setViewportSize(viewport)
    await panel(page).getByRole("button", { name: /input-helper Check input$/ }).click()
    const sheet = page.getByRole("dialog", { name: "Subagent run" })
    await sheet.getByRole("button", { name: "Skip", exact: true }).click()
    await expect(sheet).toContainText("Sub-agent skipped")
    expect((await tasks.sent("cancel")).map((s) => s.id)).toEqual([childOf("input")])
    await page.keyboard.press("Escape")
    await expect(childQuestion(page, "input")).toBeHidden()
    await expect(panel(page)).not.toContainText("Task cancelled")
  })
}

test("a failed skip says so and keeps the question", async ({ page, tasks }) => {
  await launch(page, tasks, "children.asking")
  await tasks.fault({ op: "cancel", status: 500, body: { code: "provider", message: "Database unavailable." }, times: 1 })
  await panel(page).getByRole("button", { name: "Skip sub-agent choice-helper" }).click()
  await expect(page.getByText(/Database unavailable\./).first()).toBeVisible()
  await expect(childQuestion(page, "choice")).toBeVisible()
})

test("an older children poll doesn't bring a skipped question back", async ({ page, tasks }) => {
  await launch(page, tasks, "children.asking")
  await expect(childQuestion(page, "choice")).toBeVisible()
  const before = (await tasks.sent("children")).length
  await tasks.fault({ op: "children", delayMs: 1500, times: 1 })
  await expect.poll(async () => (await tasks.sent("children")).length).toBeGreaterThan(before)
  await panel(page).getByRole("button", { name: "Skip sub-agent choice-helper" }).click()
  await expect(childQuestion(page, "choice")).toBeHidden()
  await page.waitForTimeout(1800)
  await expect(childQuestion(page, "choice")).toBeHidden()
})
