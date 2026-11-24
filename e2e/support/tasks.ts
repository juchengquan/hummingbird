import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test as base, type Locator, type Page } from "@playwright/test"

import { STORE_VERSION } from "../../lib/client/hooks/store/migrate"

import { composer } from "./runs"
import { USER_ID, signIn } from "./tasks-session"

export const HAIKU = "anthropic/claude-haiku-4.5"
export const NOT_FOR_TASKS = "deepseek/deepseek-v4-flash"
export const PHONE = { width: 390, height: 844 }
export const DESKTOP = { width: 1280, height: 800 }

interface StageRow {
  id: string
  parent_task_id: string | null
  status: string
  goal: string
  seq: number
}

const LOGS = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "task-logs.json"), "utf8"),
) as {
  stages: Record<string, StageRow[]>
  events: { task_id: string; seq: number; kind: string; payload: Record<string, unknown> }[]
}

/** The recorded task at the root of a stage. */
export const rootOf = (stage: string): string => LOGS.stages[stage][0].id
/** The recorded child whose question is of `kind`. */
export const childOf = (kind: string): string =>
  LOGS.stages["children.asking"].find((row) => row.goal === `Check ${kind}`)!.id
/** The root's last `seq` at a stage. */
export const lastSeqOf = (stage: string): number => LOGS.stages[stage][0].seq
/** One task's recorded events. */
export const eventsOf = (id: string) => LOGS.events.filter((e) => e.task_id === id)

export interface Sent {
  op: string
  id?: string
  body?: Record<string, unknown>
  cursor?: string
}

export interface TasksBackend {
  /** Show a recorded stage (rows + logs). */
  stage(name: string): Promise<void>
  /** The stage the next `POST /api/tasks` starts as. */
  startAs(name: string): Promise<void>
  /** Change one row; `null` deletes it. */
  row(id: string, patch: Record<string, unknown> | null): Promise<void>
  events(events: Record<string, unknown>[]): Promise<void>
  schedules(schedules: Record<string, unknown>[]): Promise<void>
  signedIn(value: boolean): Promise<void>
  fault(fault: {
    op: "start" | "stream" | "children" | "respond" | "cancel"
    status?: number
    body?: unknown
    delayMs?: number
    times?: number
  }): Promise<void>
  clearFaults(): Promise<void>
  /** An answer that was accepted but never applied may be given again. */
  forgetAnswers(): Promise<void>
  /** End every open stream, as the route's 5-minute cap does. */
  dropStreams(): Promise<void>
  sent(op?: string): Promise<Sent[]>
}

/**
 * `tasks`: every `/api/tasks/**` request of the context's pages (a second
 * tab, a reload) reaches `tasks-backend.ts`: the real stream and children
 * handlers over the executor's recorded logs.
 */
export const test = base.extend<{ tasks: TasksBackend }, { tasksOrigin: string }>({
  tasksOrigin: [
    // Playwright requires the destructuring, also when it is empty.
    async ({}, provide) => {
      const child = spawn("bun", [join(__dirname, "tasks-backend.ts")], {
        cwd: join(__dirname, "..", ".."),
        stdio: ["ignore", "pipe", "inherit"],
      })
      const origin = await new Promise<string>((resolve, reject) => {
        let out = ""
        child.stdout.on("data", (chunk) => {
          out += String(chunk)
          const found = out.match(/tasks-backend (http:\/\/[\d.:]+)/)
          if (found) resolve(found[1])
        })
        child.once("error", reject)
        child.once("exit", (code) => reject(new Error(`tasks-backend exited (${code})`)))
      })
      await provide(origin)
      child.kill()
    },
    { scope: "worker" },
  ],
  tasks: async ({ tasksOrigin, context }, provide) => {
    const post = async (action: string, args: object = {}) => {
      const res = await fetch(`${tasksOrigin}/__control`, {
        method: "POST",
        body: JSON.stringify({ action, ...args }),
      })
      if (!res.ok) throw new Error(`tasks-backend ${action}: ${res.status}`)
      return res.json()
    }
    await post("reset")
    // `continue`, not `fulfill`: the stream must stay a stream.
    await context.route(/\/api\/tasks(\/|\?|$)/, (route) => {
      const url = new URL(route.request().url())
      return route.continue({ url: `${tasksOrigin}${url.pathname}${url.search}` })
    })
    await provide({
      stage: async (name) => void (await post("stage", { name })),
      startAs: async (name) => void (await post("startAs", { name })),
      row: async (id, patch) => void (await post("row", { id, patch })),
      events: async (events) => void (await post("events", { events })),
      schedules: async (schedules) => void (await post("schedules", { schedules })),
      signedIn: async (value) => void (await post("signedIn", { value })),
      fault: async (fault) => void (await post("fault", fault)),
      clearFaults: async () => void (await post("clearFaults")),
      forgetAnswers: async () => void (await post("forgetAnswers")),
      dropStreams: async () => void (await post("drop")),
      sent: async (op) => {
        const all = (await post("sent")) as Sent[]
        return op ? all.filter((s) => s.op === op) : all
      },
    })
    await post("reset")
  },
})

// --- the app ------------------------------------------------------------

/** A new chat, with `state` in the persisted store (seeded once per context).
 *  Signed in (tasks need it, bug 20) unless `signedIn: false`. */
export async function openApp(
  page: Page,
  state: Record<string, unknown> = {},
  { signedIn = true }: { signedIn?: boolean } = {},
): Promise<void> {
  if (signedIn) await signIn(page.context())
  await page.addInitScript(
    ({ seed, version }) => {
      if (localStorage.getItem("e2e-seeded")) return
      localStorage.setItem("hummingbird-storage", JSON.stringify({ state: seed, version }))
      localStorage.setItem("e2e-seeded", "1")
    },
    // Signed in with sync off ("local only"): the fake Supabase keeps no
    // rows, so a sync pull would empty the store these specs seed.
    { seed: { chatBackend: "ts", chatModel: HAIKU, localOnlyMode: signedIn, ...state }, version: STORE_VERSION },
  )
  await page.goto("/")
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
}

export const taskToggle = (page: Page): Locator =>
  page.getByRole("button", { name: "Task", exact: true })

/** Send with Enter: the note's toast can cover the Send button. */
export async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text)
  await composer(page).press("Enter")
}

export async function sendAsTask(page: Page, text = "Write the report"): Promise<void> {
  const toggle = taskToggle(page)
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  await send(page, text)
}

/** Open the app, launch a task that starts as `stage`, and wait until it is being watched. */
export async function launch(page: Page, tasks: TasksBackend, stage: string): Promise<string> {
  await tasks.startAs(stage)
  await openApp(page)
  await sendAsTask(page)
  await expect.poll(async () => (await tasks.sent("stream")).length).toBeGreaterThan(0)
  await expect(panel(page)).toContainText(/Step \d|Task (finished|failed|cancelled)/)
  await waitSaved(page)
  return rootOf(stage)
}

/** The Tasks panel. */
export const panel = (page: Page): Locator =>
  page.locator("aside").filter({ has: page.getByRole("button", { name: "Close tasks panel" }) })

/** The task's own Cancel: first in the panel (a confirm card has one too). */
export const cancelButton = (page: Page): Locator =>
  panel(page)
    .getByRole("button", { name: /^Cancel( task)?$/ })
    .first()

/** A sub-agent's question on the parent task. */
export const childQuestion = (page: Page, kind: string): Locator =>
  panel(page).getByRole("group", { name: `Question from sub-agent ${kind}-helper` })

export const spinners = (scope: Locator): Locator => scope.locator(".animate-spin")

/** What the store has persisted (its writes are debounced by 100 ms). */
export async function persisted(page: Page): Promise<{
  conversations: { id: string; messages: { role: string; content: string }[] }[]
  documents: { title: string; content: string }[]
  artifacts: { title: string; content: string }[]
  projectTasks: { id: string; status: string; taskId?: string | null; artifactId?: string | null }[]
  chatModel: string
}> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("hummingbird-storage") ?? "{}").state)
}

/** Wait for the store's debounced write of the sent message: a second tab
 *  opened before it starts from a store without the conversation. */
export async function waitSaved(page: Page, text = "Write the report"): Promise<void> {
  await expect
    .poll(async () => JSON.stringify((await persisted(page))?.conversations ?? []))
    .toContain(text)
}

/** Assistant messages with exactly the recorded report. */
export async function reportCounts(page: Page) {
  const state = await persisted(page)
  const isReport = (content: string) => content.includes("The release is ready")
  return {
    messages: (state.conversations ?? [])
      .flatMap((c) => c.messages)
      .filter((m) => m.role === "assistant" && isReport(m.content)).length,
    documents: (state.documents ?? []).filter((d) => isReport(d.content)).length,
    artifacts: (state.artifacts ?? []).filter((a) => isReport(a.content)).length,
  }
}

/** The old path's pointer key: per user when signed in (Q68), the unkeyed
 *  slot otherwise. Specs are signed in as `USER_ID` unless they opt out. */
const POINTER_KEYS = [`humm.activeTask.${USER_ID}`, "humm.activeTask"]

/** The saved pointer of the task being watched. */
export const pointer = (page: Page): Promise<string | null> =>
  page.evaluate((keys) => keys.map((k) => localStorage.getItem(k)).find((v) => v !== null) ?? null, POINTER_KEYS)

/** Write the pointer back where the app reads it (the signed-in user's key). */
export const setPointer = (page: Page, value: string): Promise<void> =>
  page.evaluate(([key, v]) => localStorage.setItem(key, v), [POINTER_KEYS[0], value] as const)

/** Turn the workspace into a project with one To-do card, then reload.
 *  `model`: the workspace's default (null = none, a launch spec's case). */
export async function seedBoard(page: Page, title = "Write the report", model: string | null = HAIKU) {
  await page.waitForTimeout(300) // the store's debounced write
  await page.evaluate(
    ({ title, model }) => {
      const saved = JSON.parse(localStorage.getItem("hummingbird-storage")!)
      const workspace = saved.state.workspaces.find(
        (w: { id: string }) => w.id === saved.state.activeWorkspaceId,
      )
      workspace.isProject = true
      if (model) workspace.defaultModel = model
      const now = new Date().toISOString()
      saved.state.projectTasks = [
        {
          id: "card-1",
          workspaceId: workspace.id,
          title,
          status: "todo",
          position: 0,
          createdAt: now,
          updatedAt: now,
        },
      ]
      saved.state.resourcesSidebarOpen = true
      saved.state.resourcesSidebarTab = "project"
      localStorage.setItem("hummingbird-storage", JSON.stringify(saved))
    },
    { title, model },
  )
  await page.reload()
  await runCard(page).waitFor()
}

/** `exact`: the draggable card is a button too, named by its whole text. */
export const runCard = (page: Page): Locator =>
  page.getByRole("button", { name: "Run as task", exact: true })

export const cardStatus = async (page: Page): Promise<string | undefined> =>
  (await persisted(page)).projectTasks?.find((t) => t.id === "card-1")?.status
