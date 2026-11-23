import { expect, type Page } from "@playwright/test"

import { DESKTOP, HAIKU, openApp, PHONE, test, type TasksBackend } from "./support/tasks"

/**
 * Q73 / Q80: the schedule editor shows the model a schedule runs on —
 * Haiku by default — and offers only models tasks can run; a schedule
 * migration 0047 paused for having no model says so, and resuming it
 * gives it Haiku.
 */

const SONNET = "anthropic/claude-sonnet-4.6"

async function openSchedules(page: Page, tasks: TasksBackend, viewport: { width: number; height: number }) {
  await openApp(page, { activeView: "workspaces" })
  await page.waitForTimeout(300)
  const { workspaceId } = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("hummingbird-storage")!)
    saved.state.activeView = "workspaces"
    localStorage.setItem("hummingbird-storage", JSON.stringify(saved))
    return { workspaceId: saved.state.activeWorkspaceId as string }
  })
  const now = new Date().toISOString()
  const schedule = {
    workspaceId,
    prompt: "Summarise",
    cron: "0 8 * * *",
    timezone: "UTC",
    systemPrompt: null,
    maxSteps: null,
    lastRunAt: null,
    lastRunTaskId: null,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
  }
  await tasks.schedules([
    { ...schedule, id: "s1", name: "Morning briefing", model: null, enabled: false },
    { ...schedule, id: "s2", name: "Evening briefing", model: HAIKU, enabled: true },
  ])
  await page.reload()
  await page.getByRole("button", { name: "Open workspace settings" }).first().click({ force: true })
  await page.setViewportSize(viewport)
  const sheet = page.getByRole("dialog")
  await page.waitForTimeout(600) // the sheet's slide-in
  return sheet
}

for (const [size, viewport] of Object.entries({ desktop: DESKTOP, phone: PHONE })) {
  test(`${size}: a schedule paused for having no model says so, and resuming gives it Haiku (Q73, Q80)`, async ({
    page,
    tasks,
  }) => {
    const sheet = await openSchedules(page, tasks, viewport)
    const notice = sheet.getByText(/Paused because it had no model/)
    await expect(notice).toHaveCount(1)
    await notice.scrollIntoViewIfNeeded()
    await expect(notice).toBeInViewport()
    const box = (await notice.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    await expect(notice).toContainText("Resume it to run it on Claude Haiku 4.5")
    await expect(sheet.getByText("Claude Haiku 4.5", { exact: true })).toHaveCount(1) // the evening one

    await sheet.getByRole("button", { name: "Resume schedule" }).click()
    await expect(page.getByText("Resumed. It runs on Claude Haiku 4.5.")).toBeVisible()
    const [patch] = await tasks.sent("schedules").then((all) => all.filter((s) => s.body))
    expect(patch.body).toEqual({ enabled: true })
    await expect(sheet.getByText(/Paused because it had no model/)).toHaveCount(0)
    await expect(sheet.getByText("Claude Haiku 4.5", { exact: true })).toHaveCount(2)
  })
}

test("the editor shows Haiku by default and offers only task models; the choice is saved (Q73)", async ({
  page,
  tasks,
}) => {
  const sheet = await openSchedules(page, tasks, DESKTOP)
  await sheet.getByRole("button", { name: "Add", exact: true }).last().click()
  const model = sheet.getByLabel("Model", { exact: true })
  await expect(model).toHaveValue(HAIKU)
  const options = await model.locator("option").allInnerTexts()
  expect(options.length).toBeGreaterThan(1)
  expect(options.every((o) => o.startsWith("Claude"))).toBe(true)
  expect(options.some((o) => /auto/i.test(o))).toBe(false)
  await model.selectOption(SONNET)
  await sheet.getByPlaceholder("Morning briefing").fill("Weekly digest")
  await sheet.getByPlaceholder(/Summarise yesterday/).fill("Digest the week")
  await sheet.getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByText("Schedule created.")).toBeVisible()
  const created = (await tasks.sent("schedules")).find((s) => s.body?.name === "Weekly digest")!
  expect(created.body!.model).toBe(SONNET)
  await expect(sheet.getByText("Claude Sonnet 4.6", { exact: true })).toBeVisible()
})

test("editing a model-less schedule shows the model it will get (Q80)", async ({ page, tasks }) => {
  const sheet = await openSchedules(page, tasks, DESKTOP)
  await sheet.getByRole("button", { name: "Edit schedule" }).first().click()
  await expect(sheet.getByLabel("Model", { exact: true })).toHaveValue(HAIKU)
  await expect(sheet.getByText(/This schedule had no model and is paused/)).toBeVisible()
  await sheet.getByRole("button", { name: "Save", exact: true }).click()
  const saved = (await tasks.sent("schedules")).find((s) => s.body?.name === "Morning briefing")!
  expect(saved.body!.model).toBe(HAIKU)
})
