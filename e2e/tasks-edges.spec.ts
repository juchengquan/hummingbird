import { expect } from "@playwright/test"

import { sendMessage } from "./support/runs"
import {
  cancelButton,
  cardStatus,
  childQuestion,
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

/** The edges of wave 5c-B: slow, failed, repeated and out-of-view. */

test("an answer nobody picked up can be given again", async ({ page, tasks }) => {
  await page.clock.install()
  await launch(page, tasks, "questions.approval")
  await panel(page).getByRole("button", { name: "Reject" }).click()
  await expect(panel(page)).toContainText("Answer sent")
  await page.clock.fastForward(61_000)
  await expect(panel(page)).toContainText("You can answer again")
  await tasks.forgetAnswers()
  await panel(page).getByRole("button", { name: "Reject" }).click()
  await expect.poll(async () => (await tasks.sent("respond")).length).toBe(2)
})

test("a reload while an answer is queued: answering again is a 409, not a second answer", async ({ page, tasks }) => {
  await launch(page, tasks, "questions.approval")
  await panel(page).getByRole("button", { name: "Reject" }).click()
  await expect(panel(page)).toContainText("Answer sent")
  await page.reload()
  await panel(page).getByRole("button", { name: "Reject" }).click()
  await expect(panel(page)).toContainText("answered elsewhere")
  await tasks.stage("questions.choice")
  await expect(panel(page)).toContainText("Which colour should it be?")
})

test("what is typed for one question isn't carried to the next", async ({ page, tasks }) => {
  await launch(page, tasks, "questions.choice")
  await panel(page).getByRole("radio", { name: "Blue" }).check()
  await tasks.stage("questions.input")
  await expect(panel(page).getByRole("textbox")).toHaveValue("")
})

test("signed out: the pointer is kept, and the watch comes back", async ({ page, tasks }) => {
  await launch(page, tasks, "questions.approval")
  await tasks.signedIn(false)
  await page.reload()
  await expect(panel(page)).toContainText("Unauthorized.")
  expect(await pointer(page)).not.toBeNull()
  await tasks.signedIn(true)
  await expect(panel(page)).toContainText("Approve action?", { timeout: 15_000 })
  await expect(panel(page)).not.toContainText("Unauthorized.")
})

test("a failed children poll keeps the questions", async ({ page, tasks }) => {
  await launch(page, tasks, "children.asking")
  await expect(childQuestion(page, "input")).toBeVisible()
  await tasks.fault({ op: "children", status: 500 })
  await expect(panel(page)).toContainText("Couldn't refresh the sub-agents")
  await expect(childQuestion(page, "input")).toBeVisible()
  await tasks.clearFaults()
  await expect(panel(page)).not.toContainText("Couldn't refresh the sub-agents")
})

test("an older children poll doesn't bring an answered question back", async ({ page, tasks }) => {
  await launch(page, tasks, "children.asking")
  await expect(childQuestion(page, "approval")).toBeVisible()
  const before = (await tasks.sent("children")).length
  await tasks.fault({ op: "children", delayMs: 5000, times: 1 })
  await expect.poll(async () => (await tasks.sent("children")).length).toBeGreaterThan(before)
  await tasks.stage("children.answered-approval")
  await expect(childQuestion(page, "approval")).toBeHidden()
  await page.waitForTimeout(5500)
  await expect(childQuestion(page, "approval")).toBeHidden()
})

test("a double click cancels once", async ({ page, tasks }) => {
  await launch(page, tasks, "questions.approval")
  await tasks.fault({ op: "cancel", delayMs: 400 })
  await cancelButton(page).dblclick({ force: true })
  await expect(panel(page)).toContainText("Task cancelled")
  expect(await tasks.sent("cancel")).toHaveLength(1)
})

test("a new task before the cancel is confirmed still settles the cancelled one", async ({ page, tasks }) => {
  await tasks.startAs("plain.queued")
  await openApp(page)
  await seedBoard(page)
  await runCard(page).click()
  await expect.poll(() => cardStatus(page)).toBe("in_progress")
  await tasks.fault({ op: "stream", delayMs: 3000 })
  await cancelButton(page).click()
  await expect(panel(page)).toContainText("Task cancelled")
  await tasks.startAs("questions.approval")
  await sendMessage(page, "/research Something else")
  await expect.poll(() => cardStatus(page)).toBe("todo")
  await expect.poll(() => pointer(page)).toContain(rootOf("questions.approval"))
})

test("a board card settles while the board isn't shown", async ({ page, tasks }) => {
  await tasks.startAs("plain.queued")
  await openApp(page)
  await seedBoard(page)
  await tasks.fault({ op: "start", delayMs: 600, times: 1 })
  await runCard(page).click()
  await page.getByRole("button", { name: "Collapse resources sidebar" }).click()
  await page.getByRole("button", { name: "Toggle Sidebar" }).first().waitFor()
  await expect.poll(() => pointer(page)).not.toBeNull()
  await tasks.stage("plain.done")
  await expect.poll(() => cardStatus(page)).toBe("done")
})

test("a waiting card doesn't spin", async ({ page, tasks }) => {
  await tasks.startAs("questions.approval")
  await openApp(page)
  await seedBoard(page)
  await runCard(page).click()
  await expect(page.getByText("Paused · needs your answer")).toHaveCount(2)
  await expect(spinners(page.locator("body"))).toHaveCount(0)
})

test("phone, panel closed: the chat says a sub-agent needs the user", async ({ page, tasks }) => {
  await launch(page, tasks, "children.asking")
  await panel(page).getByRole("button", { name: "Close tasks panel" }).click()
  await page.setViewportSize(PHONE)
  const line = page.getByRole("button", { name: /4 sub-agents need your answer/ })
  await expect(line).toBeInViewport()
  await line.click()
  await expect(childQuestion(page, "approval")).toBeVisible()
})

test("a log longer than PostgREST's max_rows replays whole on reload", async ({ page, tasks }) => {
  const id = await launch(page, tasks, "plain.queued")
  const at = new Date().toISOString()
  await tasks.events([
    ...Array.from({ length: 2300 }, (_, i) => ({
      task_id: id,
      seq: i + 2,
      step: 1,
      kind: "token",
      payload: { text: i === 0 ? "first " : i === 2299 ? "last" : "x ", channel: "text" },
      created_at: at,
    })),
  ])
  await page.reload()
  await expect(panel(page)).toContainText("first")
  await expect(panel(page)).toContainText("last")
})
