/**
 * Q133 on the surfaces besides chat (wave 12, Q121–Q139): on the default
 * backend ("agent-py (runs)", no stored choice) a bookmark, a file upload
 * (signed out and in) and Explain on a selection all work without the
 * browser calling Next's `/api/*` — the guard fails a test that does.
 */
import { expect, test, type Page } from "./guard"

import { STORE_VERSION } from "../lib/client/hooks/store/migrate"

const SUPA = "http://127.0.0.1:54871"
const { LIVE_ANON: ANON } = process.env as Record<string, string>
const composer = (p: Page) => p.getByPlaceholder("Ask me anything!")

async function newChat(page: Page) {
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
}

/** The resources panel on one of its tabs ("Files", "Links", …). */
async function resourcesTab(page: Page, label: string) {
  const tab = page.getByRole("button", { name: label, exact: true })
  if ((await tab.getAttribute("aria-pressed")) !== "true") await tab.click()
  await expect(tab).toHaveAttribute("aria-pressed", "true")
}

/** A fresh account, signed in, its workspace a uuid so it can sync (no chat backend seeded). */
async function signedIn(page: Page) {
  const r = await fetch(`${SUPA}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email: `${crypto.randomUUID()}@example.test`, password: crypto.randomUUID() }),
  })
  const s = await r.json()
  const raw = "base64-" + Buffer.from(JSON.stringify(s)).toString("base64url")
  await page.context().addCookies([{ name: "sb-127-auth-token", value: raw, domain: "127.0.0.1", path: "/" }])
  const id = crypto.randomUUID(), now = new Date().toISOString()
  const seed = { workspaces: [{ id, name: "Next-free", createdAt: now, updatedAt: now }], activeWorkspaceId: id, conversations: [] }
  await page.addInitScript(({ seed, version }) => {
    if (localStorage.getItem("e2e-seeded")) return
    localStorage.setItem("hummingbird-storage", JSON.stringify({ state: seed, version }))
    localStorage.setItem("e2e-seeded", "1")
  }, { seed, version: STORE_VERSION })
}

type StoredFile = { name: string; extractionStatus?: string; extractedText?: string }
const storedFile = (page: Page, name: string) =>
  page.evaluate((name) => {
    const s = JSON.parse(localStorage.getItem("hummingbird-storage") ?? "{}")
    return ((s.state?.files ?? []) as StoredFile[]).find((f) => f.name === name) ?? null
  }, name)

/** Upload a small text file to the workspace through the Files tab; its text is extracted. */
async function uploadAndExtract(page: Page) {
  const name = `notes-${crypto.randomUUID().slice(0, 8)}.md`
  const marker = `MARKER-${crypto.randomUUID().slice(0, 8)}`
  await newChat(page)
  await resourcesTab(page, "Files")
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: "Upload files to workspace" }).click()
  await (await chooser).setFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(`# Notes\n\n${marker} is in here.\n`) })
  const row = page.getByText(name, { exact: true }).first()
  await expect(row).toBeVisible()
  await expect.poll(async () => (await storedFile(page, name))?.extractionStatus).toBe("done")
  expect((await storedFile(page, name))?.extractedText).toContain(marker)
  // Done shows no badge: not extracting, not failed, nothing to re-extract.
  await expect(page.getByText("Extracting…")).toHaveCount(0)
  await expect(page.getByText("Extraction failed")).toHaveCount(0)
  await expect(page.getByRole("button", { name: `Re-extract "${name}"` })).toHaveCount(0)
}

test("signed out: a URL bookmark is fetched and saved", async ({ page }) => {
  const name = crypto.randomUUID().slice(0, 8)
  await page.goto("/")
  await newChat(page)
  await resourcesTab(page, "Links")
  await page.getByRole("button", { name: "Add a bookmark to the workspace" }).click()
  await page.getByPlaceholder("https://example.com/article").fill(`http://127.0.0.1:8172/page/${name}`)
  await page.getByRole("button", { name: "Save bookmark" }).click()
  // The page's own title, fetched by the server, names the row and the toast.
  await expect(page.getByText(`Saved "Live page ${name}"`)).toBeVisible()
  await expect(page.getByText(`Live page ${name}`, { exact: true }).first()).toBeVisible()
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("hummingbird-storage") ?? "{}").state?.urlBookmarks ?? [])
  await expect.poll(saved).toEqual([expect.objectContaining({ title: `Live page ${name}`, content: expect.stringContaining(`Body text of ${name}.`) })])
})

test("signed out: an uploaded file's text is extracted", async ({ page }) => {
  await page.goto("/")
  await uploadAndExtract(page)
})

test("signed in: an uploaded file's text is extracted", async ({ page }) => {
  await signedIn(page)
  await page.goto("/")
  await page.getByRole("button", { name: "Account menu" }).waitFor()
  await uploadAndExtract(page)
})

test("signed out: Explain on a selection in an answer streams an explanation", async ({ page }) => {
  await page.goto("/")
  await newChat(page)
  await composer(page).fill("next-free explain hello")
  await composer(page).press("Enter")
  const answer = page.locator("[data-selection-scope]").last()
  await expect(answer.getByText("ok", { exact: true })).toBeVisible()
  await answer.getByText("ok", { exact: true }).selectText()
  await page.getByRole("toolbar", { name: "Selection actions" }).getByRole("button", { name: /Explain/ }).click()
  const popover = page.getByRole("dialog", { name: "Explanation" })
  await expect(popover).toBeVisible()
  // Copy shows once the stream ended without an error.
  await expect(popover.getByRole("button", { name: "Copy" })).toBeVisible()
  await expect(popover.getByText("Thinking…")).toHaveCount(0)
  const body = (await popover.locator(".markdown-chat-bubble").innerText()).trim()
  expect(body.length).toBeGreaterThan(0)
})
