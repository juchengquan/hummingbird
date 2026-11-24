import { expect, type Page } from "@playwright/test"

import { backendAcceptsModel, modelsForBackend } from "../lib/shared/backend-models"
import { CHAT_MODELS } from "../lib/shared/models"

import { createPersona, SERVER } from "./support/persona"
import { composer } from "./support/runs"
import {
  DESKTOP,
  NOT_FOR_TASKS,
  openApp,
  panel,
  persisted,
  PHONE,
  runCard,
  seedBoard,
  send,
  sendAsTask,
  taskToggle,
  test,
  type TasksBackend,
} from "./support/tasks"

/** Q55 / B21: a task is launched only with a model the worker runs. */

const SWITCHED_TO = modelsForBackend("agent-service")[0].id
const NOTE = /isn't available in tasks\. Switched to/

async function launchedModel(tasks: TasksBackend): Promise<string> {
  await expect.poll(async () => (await tasks.sent("start")).length).toBe(1)
  const model = (await tasks.sent("start"))[0].body?.model as string
  expect(backendAcceptsModel("agent-service", model), `${model} can't run as a task`).toBe(true)
  return model
}

async function pickerOptions(page: Page): Promise<string[]> {
  await page.getByRole("combobox", { name: "Model", exact: true }).click()
  const options = await page.getByRole("option").allInnerTexts()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("option")).toHaveCount(0)
  return options
}

// The old path's backends; "agent-py (runs)" launches on /v1/runs, and the
// same rule is checked there in tasks-wire.spec.ts.
for (const chatBackend of ["ts", "python", "ts-service"]) {
  for (const chatModel of [NOT_FOR_TASKS, "auto"]) {
    test(`Task toggle on ${chatBackend} with ${chatModel}`, async ({ page, tasks }) => {
      await openApp(page, { chatBackend, chatModel })
      await taskToggle(page).click()
      const labels = modelsForBackend("agent-service").map((m) => m.label)
      expect(await pickerOptions(page)).toEqual(labels)
      await send(page, "Write the report")
      await launchedModel(tasks)
    })
  }

  test(`/research on ${chatBackend} with ${NOT_FOR_TASKS}`, async ({ page, tasks }) => {
    await openApp(page, { chatBackend, chatModel: NOT_FOR_TASKS })
    await send(page, "/research Write the report")
    await launchedModel(tasks)
  })
}

test("switching for Task mode is said, every time", async ({ page, tasks }) => {
  await openApp(page, { chatModel: NOT_FOR_TASKS })
  await taskToggle(page).click()
  await expect(page.getByText(NOTE)).toHaveCount(1)
  await taskToggle(page).click()

  await page.getByRole("combobox", { name: "Model", exact: true }).click()
  const label = CHAT_MODELS.find((m) => m.id === NOT_FOR_TASKS)!.label
  await page.getByRole("option", { name: label, exact: true }).click()
  await taskToggle(page).click()
  await expect(page.getByText(NOTE)).toHaveCount(2)
  expect(await tasks.sent("start")).toHaveLength(0)
})

test("ordinary chat keeps every model", async ({ page, tasks }) => {
  await openApp(page, { chatModel: NOT_FOR_TASKS })
  const before = await pickerOptions(page)
  expect(before.length).toBeGreaterThan(modelsForBackend("agent-service").length)
  await taskToggle(page).click()
  await taskToggle(page).click()
  expect(await pickerOptions(page)).toEqual(before)
  expect(await tasks.sent("start")).toHaveLength(0)
})

for (const [size, viewport] of Object.entries({ desktop: DESKTOP, phone: PHONE })) {
  test(`${size}: /research switches with a note, and chat keeps its model`, async ({ page, tasks }) => {
    await openApp(page, { chatModel: NOT_FOR_TASKS })
    await page.setViewportSize(viewport)
    await send(page, "/research Write the report")
    await launchedModel(tasks)
    await expect(page.getByText(NOTE)).toBeInViewport()
    await expect.poll(async () => (await persisted(page)).chatModel).toBe(NOT_FOR_TASKS)
  })
}

test("the board switches with a note", async ({ page, tasks }) => {
  await openApp(page)
  await seedBoard(page, "Write the report", NOT_FOR_TASKS)
  await runCard(page).click()
  await launchedModel(tasks)
  await expect(page.getByText(NOTE).first()).toBeVisible()
})

test("the board with no workspace model still names a model", async ({ page, tasks }) => {
  await openApp(page)
  await seedBoard(page, "Write the report", null)
  await runCard(page).click()
  await launchedModel(tasks)
})

for (const launchAs of ["toggle", "research"] as const) {
  test(`a persona's model doesn't slip through (${launchAs})`, async ({ page, tasks }) => {
    await openApp(page, { mcpServers: [SERVER] })
    await createPersona(page, { allowServer: false, model: NOT_FOR_TASKS })
    if (launchAs === "toggle") await sendAsTask(page, "/helper Write the report")
    else {
      // Pinned: `/research` has no room for a `/persona`.
      await page.waitForTimeout(300)
      await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("hummingbird-storage")!)
        saved.state.activeAgentId = saved.state.agents[0].id
        localStorage.setItem("hummingbird-storage", JSON.stringify(saved))
      })
      await page.reload()
      await composer(page).waitFor()
      await send(page, "/research Write the report")
    }
    await launchedModel(tasks)
    await expect(page.getByText(NOTE).first()).toBeVisible()
  })
}

for (const [size, viewport] of Object.entries({ desktop: DESKTOP, phone: PHONE })) {
  test(`${size}: a 400 from the route is shown`, async ({ page, tasks }) => {
    await openApp(page)
    await page.setViewportSize(viewport)
    await tasks.fault({ op: "start", status: 400, body: { code: "unknown_model", message: "Tasks can't run that model." } })
    await sendAsTask(page)
    await expect(panel(page)).toContainText("Tasks can't run that model.")
    await expect(page.locator("[data-sonner-toast]")).toContainText("Tasks can't run that model.")
  })
}

test("a 400 on the board reverts the card and says why", async ({ page, tasks }) => {
  await openApp(page)
  await seedBoard(page)
  await tasks.fault({ op: "start", status: 400, body: { code: "unknown_model", message: "Tasks can't run that model." } })
  await runCard(page).click()
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Tasks can't run that model." })
  ).toBeVisible()
  await expect(runCard(page)).toBeVisible()
})

test("a tab in Task mode doesn't undo another tab's pick for chat", async ({ page, context, tasks }) => {
  await openApp(page)
  await page.waitForTimeout(300) // the store's debounced write, for the other tab
  await taskToggle(page).click()
  // The user leaves this tab (headless pages all report focus).
  await page.evaluate(() => {
    document.hasFocus = () => false
    window.dispatchEvent(new Event("blur"))
  })
  const other = await context.newPage()
  await other.goto("/")
  await other.getByRole("combobox", { name: "Model", exact: true }).click()
  const label = CHAT_MODELS.find((m) => m.id === NOT_FOR_TASKS)!.label
  await other.getByRole("option", { name: label, exact: true }).click()
  await page.waitForTimeout(800)
  expect((await persisted(other)).chatModel).toBe(NOT_FOR_TASKS)

  await page.evaluate(() => {
    document.hasFocus = () => true
    window.dispatchEvent(new Event("focus"))
  })
  await expect(page.getByText(NOTE)).toBeVisible()
  await expect.poll(async () => (await persisted(page)).chatModel).toBe(SWITCHED_TO)
  expect(await tasks.sent("start")).toHaveLength(0)
})
