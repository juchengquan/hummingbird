import { expect, test as base, type Page } from "@playwright/test"

import { STORE_VERSION } from "../lib/client/hooks/store/migrate"

import { WIRE_ORIGIN } from "./tasks-wire.config"
import { composer } from "./support/runs"
import { manifest, recordedInterrupt } from "./support/tasks-fake"
import { signIn } from "./support/tasks-session"

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

/** Signed in (a GoTrue session cookie for the fake origin), on agent-py (runs). */
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
        chatBackend: "python-runs",
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
