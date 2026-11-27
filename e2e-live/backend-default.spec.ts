/**
 * Chat runs on agent-py's runs API, the only path (wave 13, Q121/Q145), on
 * the real stack: a fresh browser chats there and stores no backend
 * setting; a browser that had picked another backend (store v35/v36) gets
 * ONE note that the setting was removed, never v36's old notice, and chats
 * on runs too.
 */
import { expect, test, type Page } from "./guard"

const composer = (p: Page) => p.getByPlaceholder("Ask me anything!")
const REMOVED = "Chat now runs on agent-py. The backend setting was removed."
const OLD_NOTICE = /You can switch back in the account menu/

/** Counts chat turns sent to agent-py's runs API. */
function runTurns(page: Page): { runs: number } {
  const seen = { runs: 0 }
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url() === "http://127.0.0.1:8171/v1/runs") seen.runs++
  })
  return seen
}

/** Send a chat turn and wait for agent-py's scripted model to answer "ok". */
async function chat(page: Page, text: string) {
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
  const reached = page.waitForRequest(
    (req) => req.method() === "POST" && req.url() === "http://127.0.0.1:8171/v1/runs",
  )
  await composer(page).fill(text)
  await composer(page).press("Enter")
  await reached
  await expect(page.getByText("ok", { exact: true }).last()).toBeVisible()
}

const stored = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("hummingbird-storage") ?? "{}"))

test("a fresh browser chats on agent-py (runs) and stores no backend setting", async ({ page }) => {
  const seen = runTurns(page)
  await page.goto("/")
  await chat(page, "default backend hello")
  expect(seen).toEqual({ runs: 1 })
  await expect(page.getByText(REMOVED)).toHaveCount(0)
  expect("chatBackend" in ((await stored(page)).state ?? {})).toBe(false)
})

for (const [label, version] of [["v35's", 35], ["v36's explicit", 36]] as const) {
  test(`a browser with ${label} 'ts' gets one note and chats on runs`, async ({ page }) => {
    await page.addInitScript((v) => {
      if (localStorage.getItem("e2e-seeded")) return
      localStorage.setItem("hummingbird-storage", JSON.stringify({ state: { chatBackend: "ts" }, version: v }))
      localStorage.setItem("e2e-seeded", "1")
    }, version)
    const seen = runTurns(page)
    await page.goto("/")
    await expect(page.getByText(REMOVED)).toHaveCount(1)
    await expect(page.getByText(OLD_NOTICE)).toHaveCount(0)
    await chat(page, "removed backend hello")
    expect(seen.runs).toBe(1)

    await page.reload()
    await composer(page).waitFor()
    await page.waitForTimeout(1500)
    await expect(page.getByText(REMOVED)).toHaveCount(0)
    expect("chatBackend" in ((await stored(page)).state ?? {})).toBe(false)
  })
}
