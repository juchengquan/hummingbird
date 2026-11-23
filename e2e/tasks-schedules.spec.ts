import { expect } from "@playwright/test"

import { DESKTOP, openApp, PHONE, test } from "./support/tasks"

/** Q56: a schedule without a model says it won't run. */

for (const [size, viewport] of Object.entries({ desktop: DESKTOP, phone: PHONE })) {
  test(`${size}: the list and the editor say a model-less schedule fails when due`, async ({ page, tasks }) => {
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
      enabled: true,
      systemPrompt: null,
      maxSteps: null,
      lastRunAt: null,
      lastRunTaskId: null,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    }
    await tasks.schedules([
      { ...schedule, id: "s1", name: "Morning briefing", model: null },
      { ...schedule, id: "s2", name: "Evening briefing", model: "anthropic/claude-haiku-4.5" },
    ])
    await page.reload()
    await page.getByRole("button", { name: "Open workspace settings" }).first().click({ force: true })
    await page.setViewportSize(viewport)
    const sheet = page.getByRole("dialog")
    const notice = sheet.getByText(/doesn't run yet/)
    await expect(notice).toHaveCount(1)
    await notice.scrollIntoViewIfNeeded()
    await expect(notice).toBeInViewport()
    await page.waitForTimeout(600) // the sheet's slide-in
    const box = (await notice.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    await expect(notice).toContainText("fails when due")

    await sheet.getByRole("button", { name: "Add", exact: true }).last().click()
    await expect(sheet.getByText(/doesn't run yet/)).toContainText("fails when due")
    // Q56: no model is assigned, and no picker is added to the editor.
    await expect(sheet.getByPlaceholder("Morning briefing")).toBeVisible()
  })
}
