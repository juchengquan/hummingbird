/**
 * The real UI on the real stack (`e2e-live/stack.sh`): GoTrue sessions,
 * PostgREST sync, the Next task routes, agent-py's worker, a scripted model
 * and an MCP server that counts what ran. What the mocked e2e suites can't
 * show: that it all works together.
 */
import { expect, test, type Page } from "./guard"

import { STORE_VERSION } from "../lib/client/hooks/store/migrate"

// These drive the old task routes on the `ts` backend on purpose (removed in wave 13).
test.use({ nextApi: "allowed" })

const SUPA = "http://127.0.0.1:54871", FAKE = "http://127.0.0.1:8172"
const HAIKU = "anthropic/claude-haiku-4.5"
const { LIVE_ANON: ANON, LIVE_SVC: SVC, LIVE_MCPKEY: MCPKEY } = process.env as Record<string, string>
const composer = (p: Page) => p.getByPlaceholder("Ask me anything!")
const panel = (p: Page) => p.locator("aside").filter({ has: p.getByRole("button", { name: "Close tasks panel" }) })
const rest = async (path: string, init: RequestInit = {}, token = SVC) => {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { ...init, headers: { apikey: ANON, authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } })
  const text = await r.text()
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const effects = async (tag: string) => {
  const all = (await (await fetch(`${FAKE}/state`)).json()).effects as Record<string, number>
  return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(tag + ":")).map(([k, v]) => [k.split(":")[1], v]))
}

// A fresh browser's default workspace is id "default", which can't sync (not a
// uuid; a separate pre-existing bug): start as an account whose workspace has one.
function workspace() {
  const id = crypto.randomUUID(), now = new Date().toISOString()
  return { workspaces: [{ id, name: "Live", createdAt: now, updatedAt: now }], activeWorkspaceId: id, conversations: [] }
}

async function signedIn(page: Page, state: Record<string, unknown> = {}) {
  const r = await fetch(`${SUPA}/auth/v1/signup`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email: `${crypto.randomUUID()}@example.test`, password: crypto.randomUUID() }) })
  const s = await r.json()
  const raw = "base64-" + Buffer.from(JSON.stringify(s)).toString("base64url")
  await page.context().addCookies([{ name: "sb-127-auth-token", value: raw, domain: "127.0.0.1", path: "/" }])
  await page.addInitScript(({ seed, version }) => {
    if (localStorage.getItem("e2e-seeded")) return
    localStorage.setItem("hummingbird-storage", JSON.stringify({ state: seed, version }))
    localStorage.setItem("e2e-seeded", "1")
  }, { seed: { chatBackend: "ts", chatModel: HAIKU, ...workspace(), ...state }, version: STORE_VERSION })
  await page.goto("/")
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
  return { uid: s.user.id as string, token: s.access_token as string }
}

/** Two cloud MCP servers (free, gated) in the user's synced workspace. */
async function servers(uid: string, token: string) {
  let ws: { id: string }[] = []
  for (let i = 0; i < 100 && !ws.length; i++) {
    ws = await rest(`workspaces?select=id&user_id=eq.${uid}`)
    if (!ws.length) await new Promise((r) => setTimeout(r, 200))
  }
  if (!ws.length) throw new Error("the workspace never synced")
  const caps = { tools: [{ name: "record", description: "Record an effect.", inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } }] }
  const tail = crypto.randomUUID().slice(8)
  for (const [id, gated] of [[`aaaaaaaa${tail}`, false], [`bbbbbbbb${tail}`, true]] as const) {
    await rest("rpc/mcp_upsert_server_with_credentials", { method: "POST", body: JSON.stringify({
      p_id: id, p_workspace_id: ws[0].id, p_name: gated ? "gated" : "free", p_url: "http://127.0.0.1:8173/mcp",
      p_credentials: { type: "bearer", headers: { Authorization: "Bearer local" } }, p_key: MCPKEY, p_capabilities: caps, p_enabled: true, p_requires_approval: gated }) }, token)
  }
}

async function sendAsTask(page: Page, text: string) {
  const toggle = page.getByRole("button", { name: "Task", exact: true })
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  await composer(page).fill(text)
  await composer(page).press("Enter")
}
const approve = (page: Page) => panel(page).getByRole("button", { name: "Approve", exact: true }).first().click()

test("task with two approvals, a reload in between: one effect each, result in the chat", async ({ page }) => {
  const { uid, token } = await signedIn(page)
  await servers(uid, token)
  await sendAsTask(page, "SCENARIO:multi/u1")
  await expect(panel(page)).toContainText("Approve action?")
  expect(await effects("u1")).toEqual({ lookup: 1 })
  await page.reload()
  await expect(panel(page)).toContainText("Approve action?")
  await approve(page)
  await expect.poll(async () => (await effects("u1")).one ?? 0).toBe(1)
  await expect(panel(page)).toContainText("Approve action?")
  await approve(page)
  await expect(page.getByText("FINAL multi").first()).toBeVisible()
  await page.waitForTimeout(2000)
  expect(await effects("u1")).toEqual({ lookup: 1, one: 1, two: 1 })
})

test("a sub-agent's question answered on the parent; the parent finishes", async ({ page }) => {
  const { uid, token } = await signedIn(page)
  await servers(uid, token)
  await sendAsTask(page, "SCENARIO:spawn/u2")
  const card = panel(page).getByRole("group", { name: /Question from sub-agent/ })
  await expect(card).toBeVisible()
  await card.getByRole("textbox").fill("this one")
  await card.getByRole("button", { name: "Submit" }).click()
  await expect(page.getByText("FINAL spawn").first()).toBeVisible()
  expect(await effects("u2")).toEqual({ beside: 1 })
})

test("cancel while paused: stays cancelled, the gated tool never runs", async ({ page }) => {
  const { uid, token } = await signedIn(page)
  await servers(uid, token)
  await sendAsTask(page, "SCENARIO:seq/u3")
  await expect(panel(page)).toContainText("Approve action?")
  await panel(page).getByRole("button", { name: /^Cancel( task)?$/ }).first().click()
  await expect(panel(page)).toContainText(/cancelled/i)
  await page.waitForTimeout(4000)
  // A settled task leaves the panel after a reload; the question must not come back.
  await page.reload()
  await composer(page).waitFor()
  await page.waitForTimeout(3000)
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0)
  expect(await effects("u3")).toEqual({})
})

test("a model tasks can't run is switched with a note, and the task runs", async ({ page }) => {
  const { uid, token } = await signedIn(page, { chatModel: "deepseek/deepseek-v4-flash" })
  await servers(uid, token)
  await sendAsTask(page, "SCENARIO:quick/u4")
  await expect(page.getByText(/can't run as a task|isn't available/).first()).toBeVisible()
  await expect(page.getByText("FINAL quick").first()).toBeVisible()
})

test("a fresh browser signs in: its data syncs and a task starts", async ({ page }) => {
  const r = await fetch(`${SUPA}/auth/v1/signup`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email: `${crypto.randomUUID()}@example.test`, password: crypto.randomUUID() }) })
  const s = await r.json()
  await page.context().addCookies([{ name: "sb-127-auth-token", value: "base64-" + Buffer.from(JSON.stringify(s)).toString("base64url"), domain: "127.0.0.1", path: "/" }])
  // Nothing seeded: the store starts from its first-run scaffolding.
  await page.goto("/")
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
  await expect.poll(async () => (await rest(`workspaces?select=id&user_id=eq.${s.user.id}`)).length, { timeout: 20000 }).toBe(1)
  await expect.poll(async () => (await rest(`conversations?select=id&user_id=eq.${s.user.id}`)).length, { timeout: 20000 }).toBeGreaterThanOrEqual(2)
  await page.getByRole("combobox", { name: "Model" }).click()
  await page.getByRole("option", { name: /Haiku/ }).first().click()
  await sendAsTask(page, "SCENARIO:quick/fresh")
  await expect(page.getByText("FINAL quick").first()).toBeVisible()
})
