import { expect, test } from "@playwright/test"

import { composer, isStartRequest, openChat, sendMessage } from "./support/runs"

/**
 * Q131 (wave 12): on "agent-py (runs)", a deploy whose agent-py serves no
 * model (`GET /v1/models` → an empty list) says so plainly — in the header
 * where the model picker was, and above the composer — and a send is
 * refused with that message: no run is started, no 503 bubble, no mock.
 * A list that can't be read keeps the built-in list (the other specs).
 *
 * The suite's agent-py serves the `anthropic/*` models (a dummy key,
 * `playwright.config.ts`), so the empty list is faked here per page.
 */

const MESSAGE = "No model provider is configured on this deploy."

test("an empty model list: the picker and the chat say so, and sending is blocked", async ({ page }) => {
  await page.route("**/v1/models", (route) =>
    route.fulfill({
      json: { models: [], defaultModel: "anthropic/claude-haiku-4.5", auto: false },
    }),
  )
  const starts: string[] = []
  page.on("request", (r) => {
    if (isStartRequest(r)) starts.push(r.url())
  })
  await openChat(page)

  await expect(page.getByTestId("model-picker-no-provider")).toHaveText(MESSAGE)
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0)
  await expect(page.getByTestId("no-model-provider")).toContainText(MESSAGE)
  await expect(page.getByTestId("no-model-provider")).toContainText("23-model-providers.md")

  await sendMessage(page, "Hello?")
  await expect(page.getByText(MESSAGE).first()).toBeVisible()
  // Refused before anything is sent: the text stays in the box.
  await expect(composer(page)).toHaveValue("Hello?")
  expect(starts).toEqual([])
  await expect(page.locator('[data-selection-scope^="message-"]')).toHaveCount(0)
})

test("a model list that can't be read keeps the built-in list (no block)", async ({ page }) => {
  await page.route("**/v1/models", (route) => route.fulfill({ status: 503, body: "down" }))
  await openChat(page)
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toBeVisible()
  await expect(page.getByTestId("no-model-provider")).toHaveCount(0)
})
