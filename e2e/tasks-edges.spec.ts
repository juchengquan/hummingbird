import { expect } from "@playwright/test"

import {
  cancelButton,
  cardStatus,
  childQuestion,
  lastSeqOf,
  launch,
  openApp,
  panel,
  persisted,
  PHONE,
  pointer,
  rootOf,
  runCard,
  seedBoard,
  send,
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
  const id = await launch(page, tasks, "questions.input")
  await panel(page).getByRole("textbox").fill("The first answer")
  // Answered elsewhere, and asked again — another question of the same kind.
  const at = { task_id: id, step: 3, created_at: new Date().toISOString() }
  const last = lastSeqOf("questions.input")
  await tasks.events([
    { ...at, seq: last + 1, kind: "approval", payload: { phase: "response", approvalId: "toolu_parent_2", value: "x" } },
    { ...at, seq: last + 2, kind: "status", payload: { status: "running" } },
    {
      ...at,
      seq: last + 3,
      kind: "approval",
      payload: { phase: "request", approvalId: "toolu_next", toolCallId: "toolu_next", tool: "askUser", requestKind: "input", prompt: "And the subtitle?" },
    },
    { ...at, seq: last + 4, kind: "status", payload: { status: "paused" } },
  ])
  await expect(panel(page)).toContainText("And the subtitle?")
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
  await tasks.fault({ op: "children", delayMs: 3500, times: 1 })
  await expect.poll(async () => (await tasks.sent("children")).length).toBeGreaterThan(before)
  await tasks.stage("children.answered-approval")
  await expect(childQuestion(page, "approval")).toBeHidden()
  await page.waitForTimeout(3800)
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
  await send(page, "/research Something else")
  await expect.poll(() => cardStatus(page)).toBe("todo")
  await expect.poll(() => pointer(page)).toContain(rootOf("questions.approval"))
})

test("a board card settles while the board isn't shown", async ({ page, tasks }) => {
  await tasks.startAs("plain.queued")
  await openApp(page)
  await seedBoard(page)
  await tasks.fault({ op: "start", delayMs: 600, times: 1 })
  await runCard(page).click()
  // Leaving chat unmounts the board (collapsing the rail only hides it).
  await page.getByRole("button", { name: "Workspaces", exact: true }).first().click()
  await expect(runCard(page)).toHaveCount(0)
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

test("a finished log longer than PostgREST's max_rows delivers its whole text", async ({ page, tasks }) => {
  const id = await launch(page, tasks, "plain.queued")
  await page.goto("about:blank")
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
  await tasks.row(id, { status: "done" })
  await page.goto("/")
  await expect
    .poll(async () => {
      const state = await persisted(page)
      const message = state.conversations.flatMap((c) => c.messages).find((m) => m.role === "assistant" && m.content.startsWith("first"))
      return message?.content.endsWith("last") ?? false
    }, { timeout: 15_000 })
    .toBe(true)
})
