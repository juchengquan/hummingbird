/**
 * Tasks on "agent-py (runs)" (wave 6, Q59–Q82) on the real stack: the list
 * driven by `GET /v1/runs`, answers as resumes and in place, cancel, and
 * delivery into the chat once, through real GoTrue, PostgREST, agent-py's
 * worker, the scripted model and the effect-counting MCP server.
 */
import { expect, test, type Page } from "@playwright/test"

import { STORE_VERSION } from "../lib/client/hooks/store/migrate"

const SUPA = "http://127.0.0.1:54871", FAKE = "http://127.0.0.1:8172"
const HAIKU = "anthropic/claude-haiku-4.5"
const { LIVE_ANON: ANON, LIVE_SVC: SVC, LIVE_MCPKEY: MCPKEY } = process.env as Record<string, string>
const composer = (p: Page) => p.getByPlaceholder("Ask me anything!")
const panel = (p: Page) => p.locator("aside").filter({ has: p.getByRole("button", { name: "Close tasks panel" }) })
const task = (p: Page, goal: string) => panel(p).getByRole("listitem", { name: `Task: ${goal}` })
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

async function signedIn(page: Page, workspaceExtra: Record<string, unknown> = {}) {
  const r = await fetch(`${SUPA}/auth/v1/signup`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email: `${crypto.randomUUID()}@example.test`, password: crypto.randomUUID() }) })
  const s = await r.json()
  const raw = "base64-" + Buffer.from(JSON.stringify(s)).toString("base64url")
  await page.context().addCookies([{ name: "sb-127-auth-token", value: raw, domain: "127.0.0.1", path: "/" }])
  const id = crypto.randomUUID(), now = new Date().toISOString()
  const seed = { chatBackend: "python-runs", chatModel: HAIKU, workspaces: [{ id, name: "Runs", createdAt: now, updatedAt: now, ...workspaceExtra }], activeWorkspaceId: id, conversations: [] }
  await page.addInitScript(({ seed, version }) => {
    if (localStorage.getItem("e2e-seeded")) return
    localStorage.setItem("hummingbird-storage", JSON.stringify({ state: seed, version }))
    localStorage.setItem("e2e-seeded", "1")
  }, { seed, version: STORE_VERSION })
  await page.goto("/")
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
  const uid = s.user.id as string, token = s.access_token as string
  await servers(uid, token)
  return { uid, token }
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

/** The task's root run as agent-py's DB holds it. */
async function root(uid: string, goal: string) {
  const rows = await rest(`tasks?select=id,status,result_delivered_at,mode&user_id=eq.${uid}&goal=eq.${encodeURIComponent(goal)}&previous_run_id=is.null&parent_task_id=is.null`)
  return rows[0] as { id: string; status: string; result_delivered_at: string | null; mode: string } | undefined
}
/** Messages in the cloud whose text contains `needle`. */
const cloudMessages = async (uid: string, needle: string) =>
  (await rest(`messages?select=id,content&user_id=eq.${uid}`)).filter((m: { content: string }) => m.content.includes(needle)).length

test("runs: two approvals answered on the list, a reload between; delivered into the chat once", async ({ page }) => {
  const { uid } = await signedIn(page)
  const goal = "SCENARIO:multi/r1"
  await sendAsTask(page, goal)
  const item = task(page, goal)
  await expect(item).toContainText("Approve action?")
  expect((await root(uid, goal))?.mode).toBe("background")
  expect(await effects("r1")).toEqual({ lookup: 1 })
  await page.reload()
  // After a reload the panel opens itself: a task needs an answer.
  await expect(item).toContainText("Approve action?")
  await item.getByRole("button", { name: "Approve", exact: true }).first().click({ timeout: 15000 })
  await expect.poll(async () => (await effects("r1")).one ?? 0, { timeout: 20000 }).toBe(1)
  await expect(item).toContainText("Approve action?")
  await item.getByRole("button", { name: "Approve", exact: true }).first().click({ timeout: 15000 })
  await expect(page.getByText("FINAL multi").first()).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => (await root(uid, goal))?.result_delivered_at ?? null, { timeout: 20000 }).not.toBeNull()
  await expect.poll(() => cloudMessages(uid, "FINAL multi"), { timeout: 20000 }).toBe(1)
  // Delivered once: a reload neither writes it again nor shows it twice.
  await page.reload()
  await composer(page).waitFor()
  await page.waitForTimeout(6000)
  expect(await cloudMessages(uid, "FINAL multi")).toBe(1)
  await expect(page.getByText("FINAL multi")).toHaveCount(1)
  expect(await effects("r1")).toEqual({ lookup: 1, one: 1, two: 1 })
})

test("runs: a sub-agent's question answered in place on its parent; the parent finishes", async ({ page }) => {
  const { uid } = await signedIn(page)
  const goal = "SCENARIO:spawn/r2"
  await sendAsTask(page, goal)
  const card = task(page, goal).getByRole("group", { name: /Question from sub-agent/ })
  await expect(card).toBeVisible({ timeout: 30000 })
  await card.getByRole("textbox").fill("this one")
  await card.getByRole("button", { name: "Submit" }).click()
  await expect(page.getByText("FINAL spawn").first()).toBeVisible({ timeout: 30000 })
  expect(await effects("r2")).toEqual({ beside: 1 })
  // Answered in place (Q59): no resume of the parent was created.
  const parent = await root(uid, goal)
  expect(parent?.status).toBe("done")
  const resumes = await rest(`tasks?select=id&previous_run_id=eq.${parent!.id}`)
  expect(resumes).toEqual([])
})

test("runs: cancel on the list while paused; the gated tool never runs, nothing delivered", async ({ page }) => {
  const { uid } = await signedIn(page)
  const goal = "SCENARIO:seq/r3"
  await sendAsTask(page, goal)
  const item = task(page, goal)
  await expect(item).toContainText("Approve action?")
  await item.getByRole("button", { name: "Cancel task" }).click()
  await expect(item).toContainText(/cancelled/i)
  await expect.poll(async () => (await root(uid, goal))?.status).toBe("cancelled")
  await page.waitForTimeout(4000)
  expect(await effects("r3")).toEqual({})
  expect(await cloudMessages(uid, "FINAL seq")).toBe(0)
})

/** The scripted model's requests, as text (what the model was told). */
const modelSaw = async () => (await (await fetch(`${FAKE}/state`)).json()).all_text as string
/** The cloud message whose text contains `needle`, with its images. */
async function cloudMessage(uid: string, needle: string) {
  const rows = (await rest(`messages?select=content,generated_images&user_id=eq.${uid}`)) as {
    content: string
    generated_images: { url: string }[] | null
  }[]
  return rows.find((m) => m.content.includes(needle))
}

test("runs: a task draws; the model never gets the unstored image's link; the image is delivered (Q86, Q87)", async ({ page }) => {
  const { uid } = await signedIn(page, { skillPrefs: { imageGen: true } })
  await sendAsTask(page, "SCENARIO:draw/i1")
  await expect(page.getByText("FINAL draw").first()).toBeVisible({ timeout: 30000 })
  // This stack has no Storage: the image is a data URL, so the model is
  // told it is shown, never the provider's temporary URL.
  const saw = await modelSaw()
  expect(saw).toContain("Shown to the user above your reply.")
  expect(saw).not.toContain("127.0.0.1:8172/img/")
  await expect.poll(async () => (await cloudMessage(uid, "FINAL draw"))?.generated_images?.length ?? 0, { timeout: 20000 }).toBe(1)
  expect((await cloudMessage(uid, "FINAL draw"))!.generated_images![0].url).toMatch(/^data:image\/png;base64,/)
})

test("runs: a sub-agent's image arrives with its parent's answer (Q87)", async ({ page }) => {
  const { uid } = await signedIn(page, { skillPrefs: { imageGen: true } })
  await sendAsTask(page, "SCENARIO:drawkid/i2")
  await expect(page.getByText("FINAL drawkid").first()).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => (await cloudMessage(uid, "FINAL drawkid"))?.generated_images?.length ?? 0, { timeout: 20000 }).toBe(1)
  expect((await cloudMessage(uid, "FINAL drawkid"))!.generated_images![0].url).toMatch(/^data:image\/png;base64,/)
  expect(await modelSaw()).not.toContain("127.0.0.1:8172/img/")
})

/** The cloud message whose text contains `needle`, with its images and files. */
async function cloudTurn(uid: string, needle: string) {
  const rows = (await rest(`messages?select=content,generated_images,generated_files&user_id=eq.${uid}`)) as {
    content: string
    generated_images: { url: string }[] | null
    generated_files: { name: string; url: string }[] | null
  }[]
  return rows.find((m) => m.content.includes(needle))
}

test("runs: a task runs code; its chart, file and output reach the chat (Q92–Q94)", async ({ page }) => {
  const { uid } = await signedIn(page, { skillPrefs: { codeInterpreter: true } })
  await sendAsTask(page, "SCENARIO:code/k1")
  await expect(page.getByText("FINAL code").first()).toBeVisible({ timeout: 30000 })
  // The model read the output and a count, never the bytes.
  const saw = await modelSaw()
  expect(saw).toContain("Returned to the user (shown above your reply): 1 chart, 1 file (answer.csv).")
  expect(saw).not.toContain("iVBORw0KGgo")
  await expect.poll(async () => (await cloudTurn(uid, "FINAL code"))?.generated_files?.length ?? 0, { timeout: 20000 }).toBe(1)
  const turn = (await cloudTurn(uid, "FINAL code"))!
  expect(turn.generated_files![0].name).toBe("answer.csv")
  expect(turn.generated_images).toHaveLength(1)
  // In the chat: the file's chip and the code output (stdout, the table).
  await expect(page.getByText("answer.csv").first()).toBeVisible()
  await expect(page.getByRole("cell", { name: "42" }).first()).toBeVisible()
})

test("runs: a sub-agent's code output arrives with its parent's answer (Q94)", async ({ page }) => {
  const { uid } = await signedIn(page, { skillPrefs: { codeInterpreter: true } })
  await sendAsTask(page, "SCENARIO:codekid/k2")
  await expect(page.getByText("FINAL codekid").first()).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => (await cloudTurn(uid, "FINAL codekid"))?.generated_files?.length ?? 0, { timeout: 20000 }).toBe(1)
  expect((await cloudTurn(uid, "FINAL codekid"))!.generated_images).toHaveLength(1)
})

test("runs: chat runs code on agent-py; the chart, file and output render (Q92)", async ({ page }) => {
  const { uid } = await signedIn(page, { skillPrefs: { codeInterpreter: true } })
  await composer(page).fill("SCENARIO:code/k3")
  await composer(page).press("Enter")
  await expect(page.getByText("FINAL code").first()).toBeVisible({ timeout: 30000 })
  await expect(page.getByText("answer.csv").first()).toBeVisible()
  await expect(page.getByRole("cell", { name: "42" }).first()).toBeVisible()
  await expect.poll(async () => (await cloudTurn(uid, "FINAL code"))?.generated_files?.length ?? 0, { timeout: 20000 }).toBe(1)
})
