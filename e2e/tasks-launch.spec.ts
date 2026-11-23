import { expect, test, type Page } from "@playwright/test"

import { CREDENTIAL, SERVER, createPersona } from "./support/persona"
import { composer } from "./support/runs"
import {
  HAIKU,
  calls,
  launches,
  openWithTasks,
  panel,
  send,
  setFake,
  summary,
  taskItem,
  taskToggle,
  type FakeSetup,
} from "./support/tasks-fake"

/**
 * Every launch point of a task on runs, and what each one hands the tasks
 * interface (`launch(input, opts)`): the Task toggle, `/research`, the
 * board's "Run as task", and resends of a task turn (bug 4). Each sends
 * its images in the message and no attachments, `research` for
 * `/research`, the persona's allow-list and "store files locally" (Q71),
 * never Auto (Q55), only signed in (bug 20), within the 5-task cap (Q72,
 * bug 1). Against the in-page fake tasks interface.
 */

const ROOT = "bbbbbbbb-0000-4000-8000-000000000001"
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

const fiveRunning = () =>
  Array.from({ length: 5 }, (_, i) => summary({ title: `Running ${i + 1}`, phase: "running", status: "running" }))

async function open(page: Page, fake: FakeSetup = {}, state: Record<string, unknown> = {}) {
  await openWithTasks(page, { launchResult: { ok: true, rootRunId: ROOT }, ...fake }, state)
}

function lastUserContent(input: Record<string, unknown>): unknown {
  const messages = input.messages as { role: string; content: unknown }[]
  return messages.filter((m) => m.role === "user").at(-1)?.content
}

test("the Task toggle: the image goes in the message, no attachments, store-files-locally, a task model (Q71)", async ({ page }) => {
  await open(page, {}, { localFilesOnly: true })
  await page.locator('input[type="file"]').first().setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG })
  await expect(page.getByText("dot.png").first()).toBeVisible()
  await taskToggle(page).click()
  await expect(taskToggle(page)).toHaveAttribute("aria-pressed", "true")
  await send(page, "Describe the picture")

  await expect.poll(async () => (await launches(page)).length).toBe(1)
  const [{ input, opts }] = await launches(page)
  const content = lastUserContent(input) as { type: string; image?: string; text?: string }[]
  expect(Array.isArray(content)).toBe(true)
  expect(content.find((p) => p.type === "text")?.text).toContain("Describe the picture")
  expect(content.find((p) => p.type === "image")?.image).toMatch(/^data:image\/png;base64,/)
  expect(input).not.toHaveProperty("attachments")
  expect(input).not.toHaveProperty("mode")
  expect(input.localFilesOnly).toBe(true)
  expect(input.model).toBe(HAIKU)
  expect(typeof input.conversationId).toBe("string")
  expect(opts).toMatchObject({ title: expect.any(String) })
  // The panel opens on the new task.
  await expect(panel(page)).toHaveAttribute("data-state", "expanded")
  await expect(taskItem(page, (opts as { title: string }).title)).toBeVisible()
})

test("a persona's MCP allow-list goes with the task (Q71)", async ({ page }) => {
  await page.addInitScript(
    ({ creds }) => {
      if (!localStorage.getItem("hummingbird-mcp-creds-v1")) {
        localStorage.setItem("hummingbird-mcp-creds-v1", JSON.stringify(creds))
      }
    },
    { creds: { [SERVER.id]: { type: "bearer", headers: { Authorization: CREDENTIAL } } } },
  )
  await open(page, {}, { mcpServers: [SERVER] })
  await createPersona(page, { allowServer: false })
  await taskToggle(page).click()
  await send(page, "/helper Summarise my notes")
  await expect.poll(async () => (await launches(page)).length).toBe(1)
  const [{ input }] = await launches(page)
  expect(input.allowedMcpServerIds).toEqual([])
  expect(JSON.stringify(input)).not.toContain(CREDENTIAL)
})

test("/research launches a research task without the toggle (Q71)", async ({ page }) => {
  await open(page)
  await expect(taskToggle(page)).toHaveAttribute("aria-pressed", "false")
  await send(page, "/research the history of tea")
  await expect.poll(async () => (await launches(page)).length).toBe(1)
  const [{ input }] = await launches(page)
  expect(input.mode).toBe("research")
  expect(lastUserContent(input)).toContain("the history of tea")
  expect(input).not.toHaveProperty("attachments")
})

test("in Task mode the model picker offers only task models, never Auto (Q55)", async ({ page }) => {
  await open(page)
  await taskToggle(page).click()
  await page.getByRole("combobox", { name: "Model" }).click()
  const options = page.getByRole("option")
  await expect(options.first()).toBeVisible()
  const names = await options.allInnerTexts()
  expect(names.some((n) => /auto/i.test(n))).toBe(false)
  expect(names.every((n) => /Claude/.test(n))).toBe(true)
})

test("asking to notify is done on the gesture that launches (Q74)", async ({ page }) => {
  await page.addInitScript(() => {
    const asked: string[] = []
    ;(window as unknown as { __asked: string[] }).__asked = asked
    class FakeNotification {
      static permission: NotificationPermission = "default"
      static async requestPermission() {
        asked.push("asked")
        return "default" as NotificationPermission
      }
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true })
  })
  await open(page)
  await taskToggle(page).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __asked: string[] }).__asked.length)).toBe(1)
  await taskToggle(page).click()
  await send(page, "/research tea")
  await expect.poll(() => page.evaluate(() => (window as unknown as { __asked: string[] }).__asked.length)).toBe(2)
})

test.describe("the cap and sign-in gate every launch point", () => {
  test("at 5 active tasks the toggle and /research are refused before anything is sent (Q72, bug 1)", async ({ page }) => {
    await open(page, { tasks: fiveRunning() })
    await send(page, "/research tea")
    await expect(page.getByText("You already have 5 tasks running. Wait for one to finish, or cancel one, then try again.")).toBeVisible()
    await taskToggle(page).click()
    await send(page, "Another one")
    expect(await calls(page, "launch")).toHaveLength(0)
    // Nothing was sent, so the message stays in the box.
    await expect(composer(page)).toHaveValue("Another one")
  })

  test("a server refusal at the cap is said plainly", async ({ page }) => {
    await open(page, { launchResult: { ok: false, code: "limit_reached", message: "Too many tasks." } })
    await send(page, "/research tea")
    await expect(page.getByText("You already have 5 tasks running. Wait for one to finish, or cancel one, then try again.")).toBeVisible()
  })

  test("signed out: no toggle, and /research is refused (bug 20)", async ({ page }) => {
    await open(page, { availability: { ok: false, reason: "signed_out" } })
    await expect(taskToggle(page)).toHaveCount(0)
    await send(page, "/research tea")
    await expect(page.getByText("Sign in to run tasks.")).toBeVisible()
    expect(await calls(page, "launch")).toHaveLength(0)
  })
})

// --- the board ----------------------------------------------------------------

async function seedBoard(page: Page) {
  await page.waitForTimeout(300) // the store's debounced write
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("hummingbird-storage")!)
    const workspace = saved.state.workspaces.find((w: { id: string }) => w.id === saved.state.activeWorkspaceId)
    workspace.isProject = true
    const now = new Date().toISOString()
    saved.state.projectTasks = [
      { id: "card-1", workspaceId: workspace.id, title: "Write the report", status: "todo", position: 0, createdAt: now, updatedAt: now },
    ]
    saved.state.resourcesSidebarOpen = true
    saved.state.resourcesSidebarTab = "project"
    localStorage.setItem("hummingbird-storage", JSON.stringify(saved))
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => !!window.__hummTasksFake)).toBe(true)
}

const runCard = (page: Page) => page.getByRole("button", { name: "Run as task", exact: true })
const card = async (page: Page) =>
  page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem("hummingbird-storage")!).state.projectTasks as {
        id: string
        status: string
        taskId?: string
      }[]).find((t) => t.id === "card-1"),
  )

test("the board's Run as task launches the card and links it by the task's root (Q69)", async ({ page }) => {
  await open(page, {}, { localFilesOnly: true })
  await seedBoard(page)
  await runCard(page).click()
  await expect.poll(async () => (await launches(page)).length).toBe(1)
  const [{ input, opts }] = await launches(page)
  expect(input.messages).toEqual([{ role: "user", content: "Write the report" }])
  expect(input.localFilesOnly).toBe(true)
  expect(input).not.toHaveProperty("attachments")
  expect(opts).toEqual({ title: "Write the report", projectTaskId: "card-1" })
  await expect.poll(async () => (await card(page))?.taskId).toBe(ROOT)
  expect((await card(page))?.status).toBe("in_progress")
  // A second card can run beside it: no "one at a time" on runs.
  await expect(page.getByText("Queued · waiting for a worker").first()).toBeVisible()
})

test("the board is bound by the cap, and a refused launch puts the card back (Q72)", async ({ page }) => {
  await open(page, { launchResult: { ok: false, code: "limit_reached", message: "cap" } })
  await seedBoard(page)
  await runCard(page).click()
  await expect(page.getByText(/You already have 5 tasks running/)).toBeVisible()
  await expect.poll(async () => (await card(page))?.status).toBe("todo")
  await setFake(page, { tasks: fiveRunning(), launchResult: null })
  await runCard(page).click()
  await expect(page.getByText(/You already have 5 tasks running/).first()).toBeVisible()
  expect(await calls(page, "launch")).toHaveLength(1)
})

test("signed out, the board offers no Run as task (bug 20)", async ({ page }) => {
  await open(page, { availability: { ok: false, reason: "signed_out" } })
  await seedBoard(page)
  await expect(page.getByText("Write the report").first()).toBeVisible()
  await expect(runCard(page)).toHaveCount(0)
})

// --- resending a task turn (bug 4) ---------------------------------------------

function seededTurn(reply: "ok" | "error") {
  const now = new Date().toISOString()
  const id = "cccccccc-0000-4000-8000-000000000001"
  return {
    conversations: [
      {
        id,
        workspaceId: "default",
        title: "Tea",
        createdAt: now,
        updatedAt: now,
        pinned: false,
        messages: [
          { id: "m-user", role: "user", content: "the history of tea", timestamp: now, taskTurn: { mode: "research" } },
          reply === "ok"
            ? { id: "m-reply", role: "assistant", content: "Tea came from China.", timestamp: now }
            : { id: "m-reply", role: "assistant", content: "", timestamp: now, error: { code: "provider" } },
        ],
      },
    ],
    activeConversationId: id,
    activeView: "chat",
  }
}

const RESENDS: { name: string; reply: "ok" | "error"; run: (page: Page) => Promise<void> }[] = [
  {
    name: "Regenerate",
    reply: "ok",
    run: (page) => page.getByRole("button", { name: "Retry response" }).last().click({ force: true }),
  },
  {
    name: "Edit",
    reply: "ok",
    run: async (page) => {
      await page.getByRole("button", { name: "Edit message" }).last().click({ force: true })
      const box = page.locator("textarea").filter({ hasText: "the history of tea" }).first()
      await box.fill("the history of green tea")
      await box.press("Enter")
    },
  },
  {
    name: "Retry",
    reply: "error",
    run: (page) => page.getByRole("button", { name: /^\s*Retry\s*$/ }).first().click(),
  },
]

for (const resend of RESENDS) {
  test(`${resend.name} of a research task turn launches a research task again (bug 4)`, async ({ page }) => {
    // A chat send would go to /v1/runs (or /api/chat): none may happen.
    let chatSends = 0
    await page.route(/\/(v1\/runs|api\/chat)(\?|$)/, (route) => {
      if (route.request().method() === "POST") chatSends += 1
      return route.fulfill({ status: 500, json: { code: "provider", message: "not in this spec" } })
    })
    await openWithTasks(page, { launchResult: { ok: true, rootRunId: ROOT } }, seededTurn(resend.reply), {
      newChat: false,
    })
    await expect(page.getByText("the history of tea").first()).toBeVisible()
    await resend.run(page)
    await expect.poll(async () => (await launches(page)).length).toBe(1)
    const [{ input }] = await launches(page)
    expect(input.mode).toBe("research")
    expect(chatSends).toBe(0)
  })
}
