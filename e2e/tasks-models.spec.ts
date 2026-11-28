import { expect, test, type Page } from "@playwright/test"

import { AGENT_PY_ORIGIN } from "./support/env"
import { openWithTasks, persisted, taskToggle } from "./support/tasks-fake"

/**
 * Q55 / B21: Task mode offers and keeps only the models the task worker
 * runs, saying so when it switches one, while chat keeps what agent-py's
 * runs take (Auto included). The launch itself (a task-runnable model on
 * the wire, whatever the chat had picked) is `tasks-wire.spec.ts`'s.
 * Against the in-page fake tasks interface.
 */

const NOTE = /isn't available in tasks\. Switched to/

async function pickerOptions(page: Page): Promise<string[]> {
  await page.getByRole("combobox", { name: "Model", exact: true }).click()
  const options = await page.getByRole("option").allInnerTexts()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("option")).toHaveCount(0)
  return options
}

async function pickAuto(page: Page): Promise<void> {
  await page.getByRole("combobox", { name: "Model", exact: true }).click()
  await page.getByRole("option", { name: "Auto", exact: true }).click()
}

test("switching for Task mode is said, every time", async ({ page }) => {
  await openWithTasks(page, { tasks: [] }, { chatModel: "auto" }, { signedIn: true })
  await taskToggle(page).click()
  await expect(page.getByText(NOTE)).toHaveCount(1)
  await taskToggle(page).click()

  await pickAuto(page)
  await taskToggle(page).click()
  await expect(page.getByText(NOTE)).toHaveCount(2)
})

test("chat keeps agent-py's models, Auto included, around Task mode", async ({ page }) => {
  await openWithTasks(page, { tasks: [] }, { chatModel: "auto" }, { signedIn: true })
  const before = await pickerOptions(page)
  expect(before).toContain("Auto")
  await taskToggle(page).click()
  expect(await pickerOptions(page)).not.toContain("Auto")
  await taskToggle(page).click()
  expect(await pickerOptions(page)).toEqual(before)
})

test("a tab in Task mode doesn't undo another tab's pick for chat", async ({ page, context }) => {
  // Signed in with sync off ("local only"): the fake Supabase keeps no rows,
  // so the second tab's sync pull would empty the store.
  await openWithTasks(page, { tasks: [] }, { localOnlyMode: true }, { signedIn: true })
  await page.waitForTimeout(300) // the store's debounced write, for the other tab
  await taskToggle(page).click()
  // The user leaves this tab (headless pages all report focus).
  await page.evaluate(() => {
    document.hasFocus = () => false
    window.dispatchEvent(new Event("blur"))
  })
  const other = await context.newPage()
  await other.goto("/")
  await pickAuto(other)
  await page.waitForTimeout(800)
  expect((await persisted(other)).chatModel).toBe("auto")

  await page.evaluate(() => {
    document.hasFocus = () => true
    window.dispatchEvent(new Event("focus"))
  })
  await expect(page.getByText(NOTE)).toBeVisible()
  // What tasks don't run goes to agent-py's own default (its `/v1/models`).
  const served = await (await fetch(`${AGENT_PY_ORIGIN}/v1/models`)).json()
  await expect.poll(async () => (await persisted(page)).chatModel).toBe(served.defaultModel)
})
