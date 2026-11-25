import { expect } from "@playwright/test"

import { openApp, test } from "./support/tasks"

/** Q89: a closed side panel's content is only shrunk to zero width, still
 *  mounted — its controls must be out of the tab order and the
 *  accessibility tree. (The resources panel's icon rail stays visible.) */

const CLOSED = 'aside[data-state="collapsed"]'

test("a closed panel's controls can't be reached by keyboard or by role", async ({ page }) => {
  await openApp(page, { resourcesSidebarOpen: false, tasksPanelOpen: false })
  await expect(page.locator(CLOSED)).toHaveCount(2)

  const focusedInClosed: string[] = []
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab")
    // Focus inside a part of the page shrunk to nothing: the panel's
    // content (the resources panel's icon rail stays visible, and usable).
    const hit = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      for (let a: Element | null = el.parentElement; a; a = a.parentElement) {
        if (a instanceof HTMLElement && a.offsetWidth === 0) {
          return el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? el.tagName
        }
      }
      return null
    })
    if (hit) focusedInClosed.push(hit)
  }
  expect(focusedInClosed).toEqual([])
  // Out of the accessibility tree too: browsers drop an inert subtree from
  // it (Playwright's role queries don't model `inert`, so check the subtree).
  const closeInert = await page
    .locator('button[aria-label="Close tasks panel"]')
    .evaluate((el) => el.closest("[inert]") !== null)
  expect(closeInert).toBe(true)
})

test("an open panel's controls can be", async ({ page }) => {
  await openApp(page, { resourcesSidebarOpen: false, tasksPanelOpen: true })
  await expect(page.getByRole("button", { name: "Close tasks panel" })).toBeVisible()
  await page.getByRole("button", { name: "Close tasks panel" }).focus()
  await expect(page.getByRole("button", { name: "Close tasks panel" })).toBeFocused()
})
