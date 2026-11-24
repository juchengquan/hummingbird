import { expect } from "@playwright/test"

import { composer } from "./support/runs"
import { launch, openApp, panel, persisted, runCard, send, taskToggle, test } from "./support/tasks"

/**
 * The old `/api/tasks` path (users not on agent-py (runs), Q61): tasks
 * need sign-in there too (bug 20), and the panel titles the task by its
 * goal with its conversation's name under it, as the runs list does.
 */

test("signed out: no Task toggle, /research is refused, the board has no Run as task (bug 20)", async ({ page, tasks }) => {
  await openApp(page, {}, { signedIn: false })
  await expect(composer(page)).toBeVisible()
  await expect(taskToggle(page)).toHaveCount(0)
  await send(page, "/research the history of tea")
  await expect(page.getByText("Sign in to run tasks.", { exact: true })).toBeVisible()
  expect(await tasks.sent("start")).toHaveLength(0)
  await page.waitForTimeout(300) // the store's debounced write
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("hummingbird-storage")!)
    const workspace = saved.state.workspaces.find((w: { id: string }) => w.id === saved.state.activeWorkspaceId)
    workspace.isProject = true
    const now = new Date().toISOString()
    saved.state.projectTasks = [
      { id: "card-1", workspaceId: workspace.id, title: "Write the report", status: "todo", position: 0, createdAt: now, updatedAt: now },
    ]
    saved.state.resourcesSidebarOpen = true
    saved.state.resourcesSidebarTab = "project"
    localStorage.setItem("hummingbird-storage", JSON.stringify(saved))
  })
  await page.reload()
  await expect(page.getByText("Write the report").first()).toBeVisible()
  await expect(runCard(page)).toHaveCount(0)
})

test("the panel titles the task by its goal, with its conversation's name", async ({ page, tasks }) => {
  await launch(page, tasks, "plain.queued")
  const state = await persisted(page)
  const active = (state as unknown as { activeConversationId: string }).activeConversationId
  const title = (state.conversations as unknown as { id: string; title: string }[]).find((c) => c.id === active)!.title
  await expect(panel(page).locator("[data-task-title]")).toHaveText("Write the report")
  await expect(panel(page).locator("[data-task-conversation]")).toHaveText(title)
})
