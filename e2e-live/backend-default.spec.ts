/**
 * "agent-py (runs)" is the default (wave 11, Q110–Q113) on the real stack:
 * a fresh browser chats on agent-py's runs API; a browser that had the old
 * default (`'ts'`, store v35) is moved and told once; a signed-in choice is
 * saved on the account (`profiles.chat_backend`) and a second browser takes
 * it on sign-in.
 */
import { expect, test, type BrowserContext, type Page } from "./guard"

const SUPA = "http://127.0.0.1:54871"
const { LIVE_ANON: ANON, LIVE_SVC: SVC } = process.env as Record<string, string>
const composer = (p: Page) => p.getByPlaceholder("Ask me anything!")
const MOVED = /Chat now runs on agent-py \(runs\)/

/** Records which backend each chat turn reached. */
function turns(page: Page): { runs: number; next: number } {
  const seen = { runs: 0, next: 0 }
  page.on("request", (req) => {
    const url = req.url()
    if (req.method() !== "POST") return
    if (url === "http://127.0.0.1:8171/v1/runs") seen.runs++
    if (url.endsWith("/api/chat")) seen.next++
  })
  return seen
}

/** Send a chat turn and wait for it to reach a backend: agent-py's scripted
 *  model answers "ok"; the Next route (no Gateway key here) answers its mock. */
async function chat(page: Page, text: string, onRuns = true) {
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
  const reached = page.waitForRequest((req) =>
    req.method() === "POST" &&
    (onRuns ? req.url() === "http://127.0.0.1:8171/v1/runs" : req.url().endsWith("/api/chat")),
  )
  await composer(page).fill(text)
  await composer(page).press("Enter")
  await reached
  if (onRuns) await expect(page.getByText("ok", { exact: true }).last()).toBeVisible()
}

async function signUp(): Promise<{ id: string; session: unknown }> {
  const r = await fetch(`${SUPA}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email: `${crypto.randomUUID()}@example.test`, password: crypto.randomUUID() }),
  })
  const s = await r.json()
  return { id: s.user.id as string, session: s }
}

async function signInto(context: BrowserContext, session: unknown) {
  const raw = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url")
  await context.addCookies([{ name: "sb-127-auth-token", value: raw, domain: "127.0.0.1", path: "/" }])
}

async function profileChoice(userId: string): Promise<string | null> {
  const r = await fetch(`${SUPA}/rest/v1/profiles?select=chat_backend&id=eq.${userId}`, {
    headers: { apikey: ANON, authorization: `Bearer ${SVC}` },
  })
  const rows = (await r.json()) as { chat_backend: string | null }[]
  return rows[0]?.chat_backend ?? null
}

const stored = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("hummingbird-storage") ?? "{}"))

test("a fresh browser chats on agent-py (runs) and stores no choice", async ({ page }) => {
  const seen = turns(page)
  await page.goto("/")
  await chat(page, "default backend hello")
  expect(seen).toEqual({ runs: 1, next: 0 })
  await expect(page.getByText(MOVED)).toHaveCount(0)
  expect((await stored(page)).state.chatBackend).toBeNull()
})

test("a browser on the old default is moved to runs and told once", async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("e2e-seeded")) return
    localStorage.setItem("hummingbird-storage", JSON.stringify({ state: { chatBackend: "ts" }, version: 35 }))
    localStorage.setItem("e2e-seeded", "1")
  })
  const seen = turns(page)
  await page.goto("/")
  await expect(page.getByText(MOVED)).toBeVisible()
  await chat(page, "moved backend hello")
  expect(seen.runs).toBe(1)
  expect(seen.next).toBe(0)

  await page.reload()
  await composer(page).waitFor()
  await page.waitForTimeout(1500)
  await expect(page.getByText(MOVED)).toHaveCount(0)
  // Switching back is an explicit choice, kept across a reload.
  await page.getByRole("switch", { name: "Switch back to the Next.js chat backend" }).click()
  await page.reload()
  await composer(page).waitFor()
  expect((await stored(page)).state.chatBackend).toBe("ts")
  await expect(page.getByRole("switch", { name: "Switch to the agent-py (runs) chat backend" })).toBeVisible()
})

test.describe("the account's choice", () => {
  // The choice it syncs is the Next.js route, so its chat turn reaches Next on purpose.
  test.use({ nextApi: "allowed" })

test("a signed-in choice follows the account into a second browser", async ({ browser }) => {
  const { id, session } = await signUp()

  const first = await browser.newContext()
  await signInto(first, session)
  const a = await first.newPage()
  await a.goto("/")
  await a.getByRole("button", { name: "Account menu" }).click()
  await a.getByRole("radio", { name: /Use the Next\.js chat backend/ }).click()
  await expect.poll(() => profileChoice(id)).toBe("ts")
  await first.close()

  const second = await browser.newContext()
  await signInto(second, session)
  const b = await second.newPage()
  const seen = turns(b)
  await b.goto("/")
  // A second device with its own welcome data is asked which set to keep.
  await b.getByRole("button", { name: "Use cloud · discard local" }).click()
  await b.getByRole("button", { name: "Account menu" }).waitFor()
  await expect.poll(async () => (await stored(b)).state.chatBackend).toBe("ts")
  await chat(b, "second browser hello", false)
  expect(seen).toEqual({ runs: 0, next: 1 })
  await second.close()
})
})
