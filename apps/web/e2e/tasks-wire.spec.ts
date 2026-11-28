import { expect, test as base, type Page } from "@playwright/test"

import { STORE_VERSION } from "../lib/client/hooks/store/migrate"
import { backendAcceptsModel } from "../lib/shared/backend-models"

import { WIRE_ORIGIN } from "./tasks-wire.config"
import { composer } from "./support/runs"
import { manifest, recordedInterrupt } from "./support/tasks-fake"
import { USER_ID, signIn } from "./support/tasks-session"

/**
 * The runs task UI on the wire (config `tasks-wire.config.ts`): what the
 * real tasks provider sends to `/v1/runs` from each launch point and
 * action, against a fake runs API serving agent-py's recorded background
 * streams, with a faked signed-in session. Needs wave 6-C's provider.
 */

const HAIKU = "anthropic/claude-haiku-4.5"
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

interface Sent {
  op: string
  method: string
  path: string
  query: string
  body?: Record<string, unknown>
  at: number
}

const control = async (action: string, args: object = {}) => {
  const res = await fetch(`${WIRE_ORIGIN}/__control`, { method: "POST", body: JSON.stringify({ action, ...args }) })
  if (!res.ok) throw new Error(`control ${action}: ${res.status}`)
  return res.json()
}
const sent = async (op?: string): Promise<Sent[]> => {
  const all = (await control("sent")) as Sent[]
  return op ? all.filter((s) => s.op === op) : all
}

const test = base.extend({
  page: async ({ page }, provide) => {
    await control("reset")
    await provide(page)
  },
})

/** Signed in (a GoTrue session cookie for the fake origin). */
async function signedIn(page: Page, state: Record<string, unknown> = {}, board = false) {
  await signIn(page.context())
  const workspace = crypto.randomUUID()
  const now = new Date().toISOString()
  // The fake's PostgREST forgets writes, so a reload's sync pull would read
  // pushed rows as deleted elsewhere: a board is seeded before the first load.
  const project = board
    ? {
        projectTasks: [
          { id: "card-1", workspaceId: workspace, title: "Write the report", status: "todo", position: 0, createdAt: now, updatedAt: now },
        ],
        activeConversationId: null,
        resourcesSidebarOpen: true,
        resourcesSidebarTab: "project",
      }
    : {}
  await page.addInitScript(
    ({ seed, version }) => {
      if (localStorage.getItem("e2e-seeded")) return
      localStorage.setItem("hummingbird-storage", JSON.stringify({ state: seed, version }))
      localStorage.setItem("e2e-seeded", "1")
    },
    {
      seed: {
        chatModel: HAIKU,
        workspaces: [{ id: workspace, name: "Wire", createdAt: now, updatedAt: now, ...(board ? { isProject: true } : {}) }],
        activeWorkspaceId: workspace,
        conversations: [],
        ...project,
        ...state,
      },
      version: STORE_VERSION,
    },
  )
  await page.goto("/")
  if (board) return
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
}

const toggle = (page: Page) => page.getByRole("button", { name: "Task", exact: true })
const panel = (page: Page) =>
  page.locator("aside").filter({ has: page.getByRole("button", { name: "Close tasks panel" }) })

async function sendText(page: Page, text: string) {
  await composer(page).fill(text)
  await composer(page).press("Enter")
}

test("the Task toggle starts a background run: images in the message, no attachments, localFilesOnly (Q71)", async ({ page }) => {
  await signedIn(page, { localFilesOnly: true })
  await page.locator('input[type="file"]').first().setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG })
  await toggle(page).click()
  await sendText(page, "Describe the picture")
  await expect.poll(async () => (await sent("start")).length).toBe(1)
  const [start] = await sent("start")
  const body = start.body as { forwardedProps: Record<string, unknown>; messages: { role: string; content: unknown }[] }
  expect(body.forwardedProps.mode).toBe("background")
  expect(body.forwardedProps.model).toBe(HAIKU)
  expect(body.forwardedProps.localFilesOnly).toBe(true)
  expect(body.forwardedProps).not.toHaveProperty("attachments")
  expect(body.forwardedProps).not.toHaveProperty("research")
  // The contract's image part (openapi.yaml, RUN_EVENTS §1): base64 in `source`.
  expect(body.messages.at(-1)?.content).toContainEqual(
    expect.objectContaining({
      type: "image",
      source: expect.objectContaining({ type: "data", mimeType: "image/png" }),
    }),
  )
  await expect(panel(page)).toContainText("Write the report")
})

// Q55 / B21: a task is launched only with a model the worker runs, whatever
// the chat had picked.
for (const chatModel of ["deepseek/deepseek-v4-flash", "auto"]) {
  test(`the Task toggle with ${chatModel} launches a task-runnable model`, async ({ page }) => {
    await signedIn(page, { chatModel })
    await toggle(page).click()
    await sendText(page, "Write the report")
    await expect.poll(async () => (await sent("start")).length).toBe(1)
    const model = ((await sent("start"))[0].body as { forwardedProps: { model: string } }).forwardedProps.model
    expect(backendAcceptsModel("agent-tasks", model), `${model} can't run as a task`).toBe(true)
  })
}

test("/research with a model tasks can't run launches a task-runnable one", async ({ page }) => {
  await signedIn(page, { chatModel: "deepseek/deepseek-v4-flash" })
  await sendText(page, "/research Write the report")
  await expect.poll(async () => (await sent("start")).length).toBe(1)
  const model = ((await sent("start"))[0].body as { forwardedProps: { model: string } }).forwardedProps.model
  expect(backendAcceptsModel("agent-tasks", model), `${model} can't run as a task`).toBe(true)
})

test("/research starts a research run (Q71)", async ({ page }) => {
  await signedIn(page)
  await sendText(page, "/research the history of tea")
  await expect.poll(async () => (await sent("start")).length).toBe(1)
  const [start] = await sent("start")
  expect((start.body as { forwardedProps: Record<string, unknown> }).forwardedProps.research).toBe(true)
})

test("a 409 limit_reached is said plainly (Q72)", async ({ page }) => {
  await signedIn(page)
  await control("fault", { op: "start", status: 409, body: { code: "limit_reached", message: "5 active tasks." } })
  await sendText(page, "/research tea")
  await expect(page.getByText(/You already have 5 tasks running/)).toBeVisible()
})

test("the board waits for its new conversation to sync, then links the card to the root (bug 5)", async ({ page }) => {
  await signedIn(page, {}, true)
  await page.getByRole("button", { name: "Run as task", exact: true }).click()
  await expect.poll(async () => (await sent("start")).length).toBe(1)
  const [start] = await sent("start")
  const pushes = (await sent()).filter((s) => s.op.startsWith("rest:conversations") && s.method !== "GET")
  expect(pushes.length).toBeGreaterThan(0)
  expect(pushes[0].at).toBeLessThanOrEqual(start.at)
  const runId = (start.body as { runId: string }).runId
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("hummingbird-storage")!).state.projectTasks[0].taskId as string,
      ),
    )
    .toBe(runId)
})

test("the list, a sub-agent's question answered in place, Skip and Cancel (Q59, Q60, Q69)", async ({ page }) => {
  const spawn = manifest("spawn").runs
  const parent = spawn.parent.runId
  const child = spawn["child-asks-paused"].runId
  const works = spawn["child-works"].runId
  const ask = recordedInterrupt("background/spawn/child-asks-paused.sse", "q")
  await control("runs", {
    runs: [
      { id: parent, rootRunId: parent, status: "running", step: 2, childrenAsking: 1, goal: "Ask the helpers" },
      { id: child, rootRunId: parent, parentRunId: parent, status: "interrupted", openInterrupts: [ask], goal: "asks" },
      { id: works, rootRunId: parent, parentRunId: parent, status: "running", goal: "works" },
    ],
  })
  await control("streams", {
    streams: {
      [parent]: "background/spawn/parent.sse",
      [child]: "background/spawn/child-asks-paused.sse",
      [works]: "background/spawn/child-works.sse",
    },
  })
  await signedIn(page)
  await page.getByRole("button", { name: /^Open tasks panel/ }).click()
  await expect.poll(async () => (await sent("list")).map((s) => s.query).join(" ")).toContain("topLevel=true")
  const item = panel(page).getByRole("listitem", { name: "Task: Ask the helpers" })
  await expect(item.getByRole("button", { name: "Skip sub-agent helper: works" })).toBeVisible()
  // An expanded task keeps one watch while the list refreshes around it: its
  // chain is read once, not again on every list tick (each re-read was a new
  // watch with an empty fold, so the sub-agents' names blinked out).
  const chainReads = async () => (await sent("list")).filter((s) => s.query.includes("rootRunId=")).length
  const before = await chainReads()
  await page.waitForTimeout(6_000)
  expect(await chainReads()).toBe(before)
  const card = item.getByRole("group", { name: /Question from sub-agent/ })
  await card.getByRole("textbox").fill("blue")
  await card.getByRole("button", { name: "Submit" }).click()
  await expect.poll(async () => (await sent("answers")).length).toBe(1)
  const [answer] = await sent("answers")
  expect(answer.path).toBe(`/v1/runs/${child}/answers`)
  expect(answer.body).toEqual({ resume: [{ interruptId: "q", status: "resolved", payload: { value: "blue" } }] })
  await expect(card).toContainText("Answer sent")

  // Both sub-agents are "helper": the label names the subgoal too.
  await item.getByRole("button", { name: "Skip sub-agent helper: works" }).click()
  await expect.poll(async () => (await sent("cancel")).map((s) => s.path)).toContain(`/v1/runs/${works}/cancel`)
  await item.getByRole("button", { name: "Cancel task" }).click()
  await expect.poll(async () => (await sent("cancel")).map((s) => s.path)).toContain(`/v1/runs/${parent}/cancel`)
})

const POINTER_KEY = `humm.activeTask.${USER_ID}`

/** The saved pointer of a task started the old way (`/api/tasks`), before load. */
async function oldPathPointer(page: Page, runId: string, status: "running" | "paused") {
  await page.addInitScript(
    ({ key, pointer }) => {
      if (localStorage.getItem("e2e-pointer-seeded")) return
      localStorage.setItem(key, JSON.stringify(pointer))
      localStorage.setItem("e2e-pointer-seeded", "1")
    },
    {
      key: POINTER_KEY,
      pointer: {
        runId,
        conversationId: crypto.randomUUID(),
        cursor: 0,
        status,
        title: "Ask the helpers",
        updatedAt: new Date().toISOString(),
      },
    },
  )
}

/** Every browser request to an old `/api/tasks` route, from now on. */
function oldTaskRoutes(page: Page): string[] {
  const seen: string[] = []
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname
    if (path.startsWith("/api/tasks")) seen.push(`${req.method()} ${path}`)
  })
  return seen
}

test("a task started the old way is followed through /v1/runs, never /api/tasks (Q126)", async ({ page }) => {
  const spawn = manifest("spawn").runs
  const parent = spawn.parent.runId
  const works = spawn["child-works"].runId
  await control("runs", {
    runs: [
      { id: parent, rootRunId: parent, status: "running", step: 2, goal: "Ask the helpers" },
      { id: works, rootRunId: parent, parentRunId: parent, status: "running", goal: "works" },
    ],
  })
  await control("streams", {
    streams: { [parent]: "background/spawn/parent.sse", [works]: "background/spawn/child-works.sse" },
  })
  const old = oldTaskRoutes(page)
  await oldPathPointer(page, parent, "running")
  await signedIn(page)
  // The panel opens on it, as the old path's reload did; its log, its
  // sub-agents and its cancel all go to the runs API.
  const item = panel(page).getByRole("listitem", { name: "Task: Ask the helpers" })
  await expect(item).toBeVisible()
  await expect.poll(async () => (await sent("events")).map((s) => s.path)).toContain(`/v1/runs/${parent}/events`)
  await expect.poll(async () => (await sent("list")).map((s) => s.query).join(" ")).toContain(`parentRunId=${parent}`)
  await item.getByRole("button", { name: "Cancel task" }).click()
  await expect.poll(async () => (await sent("cancel")).map((s) => s.path)).toContain(`/v1/runs/${parent}/cancel`)
  // Ended: the pointer goes.
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), POINTER_KEY)).toBeNull()
  expect(old).toEqual([])
})

test("a pointer to an old-path task that finished while away is dropped, read only through /v1/runs (Q126)", async ({ page }) => {
  const root = crypto.randomUUID()
  await control("runs", {
    runs: [
      {
        id: root,
        rootRunId: root,
        status: "succeeded",
        goal: "Ask the helpers",
        result: { text: "Done." },
        finishedAt: new Date().toISOString(),
      },
    ],
  })
  const old = oldTaskRoutes(page)
  await oldPathPointer(page, root, "paused")
  await signedIn(page)
  await expect.poll(async () => (await sent("list")).length).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), POINTER_KEY)).toBeNull()
  // Time for a stray old-path watch to show itself.
  await page.waitForTimeout(1_000)
  expect(old).toEqual([])
})

// --- launch models (Q55 / B21), moved from the old path's tasks-models spec

const NOTE = /isn't available in tasks\. Switched to/
const toast = (page: Page) => page.locator("[data-sonner-toast]")

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

async function launchedModel(): Promise<string> {
  await expect.poll(async () => (await sent("start")).length).toBe(1)
  const model = ((await sent("start"))[0].body as { forwardedProps: { model: string } }).forwardedProps.model
  expect(backendAcceptsModel("agent-tasks", model), `${model} can't run as a task`).toBe(true)
  return model
}

for (const [size, viewport] of Object.entries({ desktop: DESKTOP, phone: PHONE })) {
  test(`${size}: /research switches with a note in view, and chat keeps its model`, async ({ page }) => {
    await signedIn(page, { chatModel: "auto" })
    await page.setViewportSize(viewport)
    await sendText(page, "/research Write the report")
    await launchedModel()
    await expect(toast(page).filter({ hasText: NOTE })).toBeInViewport()
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("hummingbird-storage")!).state.chatModel))
      .toBe("auto")
  })

  test(`${size}: a start refused 400 says why`, async ({ page }) => {
    await signedIn(page)
    await page.setViewportSize(viewport)
    await control("fault", { op: "start", status: 400, body: { code: "unknown_model", message: "Tasks can't run that model." } })
    await toggle(page).click()
    await sendText(page, "Write the report")
    await expect(toast(page).filter({ hasText: "Tasks can't run that model." })).toBeVisible()
  })
}

test("the board launches with a task model, saying so when it switches one", async ({ page }) => {
  await signedIn(page, { chatModel: "auto" }, true)
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("hummingbird-storage")!)
    saved.state.workspaces[0].defaultModel = "auto"
    localStorage.setItem("hummingbird-storage", JSON.stringify(saved))
  })
  await page.reload()
  await page.getByRole("button", { name: "Run as task", exact: true }).click()
  await launchedModel()
  await expect(toast(page).filter({ hasText: NOTE }).first()).toBeVisible()
})

test("the board with no workspace model still names a model", async ({ page }) => {
  await signedIn(page, {}, true)
  await page.getByRole("button", { name: "Run as task", exact: true }).click()
  await launchedModel()
})

test("a board start refused 400 puts the card back and says why", async ({ page }) => {
  await signedIn(page, {}, true)
  await control("fault", { op: "start", status: 400, body: { code: "unknown_model", message: "Tasks can't run that model." } })
  await page.getByRole("button", { name: "Run as task", exact: true }).click()
  await expect(toast(page).filter({ hasText: "Tasks can't run that model." })).toBeVisible()
  await expect(page.getByRole("button", { name: "Run as task", exact: true })).toBeVisible()
})

// --- schedules on agent-py (Q73, Q80), moved from the old path's spec -------

const SONNET = "anthropic/claude-sonnet-4.6"

async function openSchedules(page: Page, viewport: { width: number; height: number }) {
  await signedIn(page)
  const workspaceId = await page.evaluate(
    () => JSON.parse(localStorage.getItem("hummingbird-storage")!).state.activeWorkspaceId as string,
  )
  const now = new Date().toISOString()
  const schedule = {
    workspaceId,
    prompt: "Summarise",
    cron: "0 8 * * *",
    timezone: "UTC",
    systemPrompt: null,
    maxSteps: null,
    lastRunAt: null,
    lastRunTaskId: null,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
  }
  await control("schedules", {
    schedules: [
      { ...schedule, id: "s1", name: "Morning briefing", model: null, enabled: false },
      { ...schedule, id: "s2", name: "Evening briefing", model: HAIKU, enabled: true },
    ],
  })
  // The schedules load when the workspace's settings open. No reload: the
  // fake PostgREST forgets writes, so a sync pull would empty the store.
  await page.getByText("Workspaces", { exact: true }).first().click()
  await page.getByRole("button", { name: "Open workspace settings" }).first().click({ force: true })
  await page.setViewportSize(viewport)
  const sheet = page.getByRole("dialog")
  await page.waitForTimeout(600) // the sheet's slide-in
  return sheet
}

const scheduleWrites = async () => (await sent("schedules")).filter((s) => s.method !== "GET")

for (const [size, viewport] of Object.entries({ desktop: DESKTOP, phone: PHONE })) {
  test(`${size}: a schedule paused for having no model says so, and resuming gives it Haiku (Q73, Q80)`, async ({
    page,
  }) => {
    const sheet = await openSchedules(page, viewport)
    const notice = sheet.getByText(/Paused because it had no model/)
    await expect(notice).toHaveCount(1)
    await notice.scrollIntoViewIfNeeded()
    await expect(notice).toBeInViewport()
    const box = (await notice.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    await expect(notice).toContainText("Resume it to run it on Claude Haiku 4.5")
    await expect(sheet.getByText("Claude Haiku 4.5", { exact: true })).toHaveCount(1) // the evening one

    await sheet.getByRole("button", { name: "Resume schedule" }).click()
    await expect(page.getByText("Resumed. It runs on Claude Haiku 4.5.")).toBeVisible()
    const [patch] = await scheduleWrites()
    expect(patch.path).toBe("/v1/tasks/schedules/s1")
    expect(patch.body).toEqual({ enabled: true })
    await expect(sheet.getByText(/Paused because it had no model/)).toHaveCount(0)
    await expect(sheet.getByText("Claude Haiku 4.5", { exact: true })).toHaveCount(2)
  })
}

test("the schedule editor shows Haiku by default and offers only task models; the choice is saved (Q73)", async ({
  page,
}) => {
  const sheet = await openSchedules(page, DESKTOP)
  await sheet.getByRole("button", { name: "Add", exact: true }).last().click()
  const model = sheet.getByLabel("Model", { exact: true })
  await expect(model).toHaveValue(HAIKU)
  const options = await model.locator("option").allInnerTexts()
  expect(options.length).toBeGreaterThan(1)
  expect(options.every((o) => o.startsWith("Claude"))).toBe(true)
  expect(options.some((o) => /auto/i.test(o))).toBe(false)
  await model.selectOption(SONNET)
  await sheet.getByPlaceholder("Morning briefing").fill("Weekly digest")
  await sheet.getByPlaceholder(/Summarise yesterday/).fill("Digest the week")
  await sheet.getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByText("Schedule created.")).toBeVisible()
  const created = (await scheduleWrites()).find((s) => s.body?.name === "Weekly digest")!
  expect(created.method).toBe("POST")
  expect(created.body!.model).toBe(SONNET)
  await expect(sheet.getByText("Claude Sonnet 4.6", { exact: true })).toBeVisible()
})

test("editing a model-less schedule shows the model it will get (Q80)", async ({ page }) => {
  const sheet = await openSchedules(page, DESKTOP)
  await sheet.getByRole("button", { name: "Edit schedule" }).first().click()
  await expect(sheet.getByLabel("Model", { exact: true })).toHaveValue(HAIKU)
  await expect(sheet.getByText(/This schedule had no model and is paused/)).toBeVisible()
  await sheet.getByRole("button", { name: "Save", exact: true }).click()
  await expect
    .poll(async () => (await scheduleWrites()).find((s) => s.body?.name === "Morning briefing")?.body?.model)
    .toBe(HAIKU)
})
