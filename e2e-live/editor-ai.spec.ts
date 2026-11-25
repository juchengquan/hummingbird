/**
 * The editor's AI on agent-py (wave 9, Q101–Q105) on the real stack: the
 * Plate editor (`/editor`) with "agent-py (runs)" selected sends its AI menu
 * and ghost-text requests to agent-py's `/v1/ai/command` + `/v1/ai/complete`,
 * which ask the scripted model (`fakes.py` `editor_reply`): `GENERATED-TEXT`,
 * `IMPROVED-TEXT`, an `EDITOR-COMMENT` on the document's first block and
 * ` jumped.` come only from there — the Next route has no gateway key here
 * and would answer with its demo stream.
 */
import { expect, test, type Page } from "@playwright/test"

import { STORE_VERSION } from "../lib/client/hooks/store/migrate"

const SUPA = "http://127.0.0.1:54871", FAKE = "http://127.0.0.1:8172"
const { LIVE_ANON: ANON } = process.env as Record<string, string>
const MOD = process.platform === "darwin" ? "Meta" : "Control"

const editorCalls = async (): Promise<string[]> => (await (await fetch(`${FAKE}/state`)).json()).editor

async function openEditor(page: Page, { signIn }: { signIn: boolean }) {
  if (signIn) {
    const r = await fetch(`${SUPA}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: ANON, "content-type": "application/json" },
      body: JSON.stringify({ email: `${crypto.randomUUID()}@example.test`, password: crypto.randomUUID() }),
    })
    const s = await r.json()
    const raw = "base64-" + Buffer.from(JSON.stringify(s)).toString("base64url")
    await page.context().addCookies([{ name: "sb-127-auth-token", value: raw, domain: "127.0.0.1", path: "/" }])
  }
  const seed = { chatBackend: "python-runs", editorPrefs: { aiReviewChanges: false, inlineComplete: true } }
  await page.addInitScript(({ seed, version }) => {
    if (localStorage.getItem("e2e-seeded")) return
    localStorage.setItem("hummingbird-storage", JSON.stringify({ state: seed, version }))
    localStorage.setItem("e2e-seeded", "1")
  }, { seed, version: STORE_VERSION })
  const toAgentPy: string[] = []
  page.on("request", (req) => {
    if (req.url().startsWith("http://127.0.0.1:8171/v1/ai/")) toAgentPy.push(new URL(req.url()).pathname)
  })
  await page.goto("/editor")
  const editor = page.locator('[data-slate-editor="true"]').first()
  await editor.click()
  await page.keyboard.press(`${MOD}+a`)
  await page.keyboard.press("Backspace")
  await page.keyboard.type("Alpha beta gamma.")
  return { editor, toAgentPy }
}

async function ask(page: Page, text: string) {
  await page.keyboard.press(`${MOD}+j`)
  const input = page.getByPlaceholder("Ask AI anything...")
  await input.waitFor()
  await input.fill(text)
  await input.press("Enter")
}

/** Select the first paragraph's first word ("Alpha"): a span inside one block. */
async function selectFirstWord(page: Page) {
  const paragraph = page.locator('[data-slate-editor="true"]').first().getByText("Alpha beta gamma.")
  await paragraph.dblclick({ position: { x: 8, y: 8 } })
}

test("free text: agent-py picks the tool and generates into the document", async ({ page }) => {
  const { editor, toAgentPy } = await openEditor(page, { signIn: true })
  const before = (await editorCalls()).length
  await page.keyboard.press("Enter")
  await ask(page, "EDITOR:generate one line please")
  await expect(editor.getByText("GENERATED-TEXT")).toBeVisible()
  expect((await editorCalls()).slice(before)).toEqual(["choose", "text"])
  expect(toAgentPy).toContain("/v1/ai/command")
})

test("Comment: agent-py's comment lands on the block it names", async ({ page }) => {
  const { editor } = await openEditor(page, { signIn: true })
  const before = (await editorCalls()).length
  await selectFirstWord(page)
  await page.getByRole("button", { name: "Ask AI" }).click()
  await page.getByRole("option", { name: "Comment" }).click()
  await expect(editor.locator('[class*="bg-highlight"]', { hasText: "Alpha beta" })).toBeVisible()
  expect((await editorCalls()).slice(before)).toEqual(["elements"])
})

test("Improve writing: the selection is edited by agent-py", async ({ page }) => {
  await openEditor(page, { signIn: true })
  const before = (await editorCalls()).length
  await selectFirstWord(page)
  // The selection's floating toolbar: what a reader with a selection uses.
  await page.getByRole("button", { name: "Ask AI" }).click()
  await page.getByRole("option", { name: "Improve writing" }).click()
  await expect(page.getByText("IMPROVED-TEXT").first()).toBeVisible()
  expect((await editorCalls()).slice(before)).toEqual(["text"])
})

test("ghost text comes from agent-py's completion", async ({ page }) => {
  const { toAgentPy } = await openEditor(page, { signIn: true })
  // Plate suggests on its own once the block ends with a space.
  await page.keyboard.type(" The quick ")
  await expect(page.getByText("jumped.")).toBeVisible()
  expect(toAgentPy).toContain("/v1/ai/complete")
})

test("signed out on agent-py (runs): the editor still reaches agent-py", async ({ page }) => {
  const { editor, toAgentPy } = await openEditor(page, { signIn: false })
  await page.keyboard.press("Enter")
  await ask(page, "EDITOR:generate anonymously")
  await expect(editor.getByText("GENERATED-TEXT")).toBeVisible()
  expect(toAgentPy).toContain("/v1/ai/command")
})

test("settings: agent-py's models, and an own gateway key keeps the Next route", async ({ page }) => {
  const { toAgentPy } = await openEditor(page, { signIn: true })
  await page.locator("button:has(svg.lucide-settings)").click()
  await expect(page.getByTestId("editor-ai-agent-py-note")).toBeVisible()
  await page.locator("#select-model").click()
  const offered = await page.getByRole("option").allTextContents()
  expect(offered.length).toBeGreaterThan(0)
  expect(offered.every((label) => /Claude/.test(label))).toBe(true)
  await page.keyboard.press("Escape")
  await page.getByLabel("AI Gateway API Key").fill("own-gateway-key")
  await expect(page.getByTestId("editor-ai-agent-py-note")).toBeHidden()
  await page.getByRole("button", { name: "Save changes" }).click()

  await page.locator('[data-slate-editor="true"]').first().click()
  await page.keyboard.press(`${MOD}+End`)
  await page.keyboard.press("Enter")
  const before = toAgentPy.length
  const toNext = page.waitForRequest((req) => req.url().endsWith("/api/ai/command"))
  await ask(page, "EDITOR:generate with my key")
  await toNext
  expect(toAgentPy.length).toBe(before)
})
