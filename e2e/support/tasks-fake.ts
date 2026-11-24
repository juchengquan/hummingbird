/**
 * The runs task UI against the in-page fake tasks interface
 * (`components/agent/tasks/e2e-fake.ts`, live only in the e2e build).
 *
 * A spec opens the app with `openWithTasks(page, { tasks, views })`; the
 * fake then shows those tasks and records what the UI asks of it
 * (`calls(page)`). The views are folded from agent-py's recorded
 * background streams (`lib/client/runs/fixtures/agent-py/background/`) by
 * `foldStream` below — a test-side reading of the same AG-UI events the
 * real reducer (wave 6-C) folds — so the panel is fed what the worker
 * produces, not hand-written shapes.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, type Locator, type Page } from "@playwright/test"

import { STORE_VERSION } from "../../lib/client/hooks/store/migrate"
import type { TaskRunView } from "../../lib/shared/agent/project"

import { composer } from "./runs"
import { signIn } from "./tasks-session"

export const HAIKU = "anthropic/claude-haiku-4.5"
export const PHONE = { width: 390, height: 844 }
export const DESKTOP = { width: 1280, height: 800 }

const FIXTURES = join(__dirname, "..", "..", "lib", "client", "runs", "fixtures", "agent-py")

type AgUi = { type: string; [k: string]: unknown }
// The interface's shapes, loosely: the specs build plain JSON.
type Json = Record<string, unknown>

/** The AG-UI events of one recorded stream. */
export function sse(path: string): AgUi[] {
  return readFileSync(join(FIXTURES, path), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as AgUi)
}

export function manifest(scenario: string): { runs: Record<string, { runId: string; status: string }> } {
  return JSON.parse(readFileSync(join(FIXTURES, "background", scenario, "manifest.json"), "utf8"))
}

/** A recorded interrupt, by fixture and interrupt id: the `Interrupt` as sent. */
export function recordedInterrupt(path: string, id: string): Json {
  for (const e of sse(path)) {
    if (e.type === "CUSTOM" && e.name === "hummingbird.interrupt_pending" && (e.value as Json).id === id) {
      return e.value as Json
    }
    if (e.type === "RUN_FINISHED") {
      const found = ((e.outcome as Json)?.interrupts as Json[] | undefined)?.find((i) => i.id === id)
      if (found) return found
    }
  }
  throw new Error(`no interrupt ${id} in ${path}`)
}

/** `toPendingInterrupt` of `lib/client/runs/interrupts.ts`, for plain JSON. */
export function pending(raw: Json): Json {
  const hb = ((raw.metadata as Json | undefined)?.hummingbird ?? {}) as Json
  const out: Json = { id: raw.id, reason: raw.reason, raw }
  for (const k of ["message", "toolCallId", "responseSchema", "expiresAt"]) if (raw[k] !== undefined) out[k] = raw[k]
  for (const k of ["tool", "args", "options", "multi", "uiKind", "uiProps"]) if (hb[k] !== undefined) out[k] = hb[k]
  return out
}

const EMPTY: TaskRunView = {
  status: "queued",
  step: 0,
  maxSteps: null,
  text: "",
  reasoning: "",
  plan: [],
  toolCalls: [],
  artifactIds: [],
  lastStepError: null,
  fatalError: null,
  resultText: null,
  verification: null,
  cursor: 0,
  pendingInput: null,
  childRuns: [],
}

/** Fold recorded streams (a chain, in order) into the view the panel shows. */
export function foldStream(paths: string[], maxSteps: number | null = 25): TaskRunView {
  const view: TaskRunView = { ...EMPTY, plan: [], toolCalls: [], childRuns: [] }
  const args = new Map<string, string>()
  for (const path of paths) {
    let step = 0
    for (const e of sse(path)) {
      switch (e.type) {
        case "STEP_STARTED":
          step += 1
          view.step = step
          view.status = "running"
          break
        case "TEXT_MESSAGE_CONTENT":
          view.text += String(e.delta)
          break
        case "TOOL_CALL_START":
          view.toolCalls.push({ toolCallId: String(e.toolCallId), toolName: String(e.toolCallName), status: "running" })
          break
        case "TOOL_CALL_ARGS":
          args.set(String(e.toolCallId), (args.get(String(e.toolCallId)) ?? "") + String(e.delta))
          break
        case "TOOL_CALL_RESULT": {
          const call = view.toolCalls.find((c) => c.toolCallId === e.toolCallId)
          if (call) {
            call.status = "done"
            try {
              call.summary = (JSON.parse(String(e.content)) as Json).summary as string
            } catch {
              call.summary = String(e.content)
            }
          }
          break
        }
        case "ACTIVITY_SNAPSHOT":
          if (e.activityType === "hummingbird.plan") view.plan = ((e.content as Json).items as TaskRunView["plan"]) ?? []
          break
        case "CUSTOM":
          if (e.name === "hummingbird.step_error") view.lastStepError = String((e.value as Json).message)
          break
        case "SUBAGENT_STARTED":
          view.childRuns.push({
            childTaskId: String(e.subagentRunId),
            agent: String(e.name),
            subgoal: String(((e.metadata as Json)?.hummingbird as Json)?.subgoal ?? ""),
          })
          break
        case "RUN_FINISHED": {
          const type = (e.outcome as Json)?.type
          view.status = type === "interrupt" ? "paused" : "done"
          if (type === "success") view.resultText = String((e.result as Json)?.text ?? view.text)
          break
        }
        case "RUN_ERROR":
          view.status = "failed"
          view.fatalError = String(e.message)
          break
      }
    }
  }
  for (const call of view.toolCalls) {
    const raw = args.get(call.toolCallId)
    if (raw) call.args = JSON.parse(raw)
  }
  view.maxSteps = maxSteps
  return view
}

let ids = 0
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`

/** A list row (`TaskSummary`), filled with what a spec doesn't care about. */
export function summary(patch: Json & { rootRunId?: string }): Json {
  const root = patch.rootRunId ?? uuid()
  const now = new Date().toISOString()
  return {
    rootRunId: root,
    currentRunId: root,
    conversationId: uuid(),
    title: "Write the report",
    research: false,
    phase: "running",
    status: "running",
    step: 1,
    maxSteps: 25,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    questions: [],
    childrenAsking: 0,
    delivered: false,
    result: null,
    error: null,
    lastAttemptError: null,
    resultIds: { messageId: uuid(), documentId: uuid(), artifactId: uuid() },
    ...patch,
  }
}

/** A `TaskQuestion` of `runId` in task `rootRunId`. */
export function question(
  rootRunId: string,
  runId: string,
  raw: Json,
  answeredBy: "resume" | "in_place",
  subagent?: { name?: string; subgoal?: string },
): Json {
  return { runId, rootRunId, interrupt: pending(raw), answeredBy, answerPending: false, ...(subagent ? { subagent } : {}) }
}

export interface FakeSetup {
  availability?: { ok: true } | { ok: false; reason: "loading" | "signed_out" | "not_runs" }
  tasks?: Json[]
  views?: Record<string, { runIds: string[]; view: TaskRunView; children: Json[]; connection: string }>
  activeLimit?: number
  launchResult?: Json | null
  answerResult?: Json | null
  runAsTask?: boolean
}

/** A fresh browser on the dashboard with the fake interface and a new chat. */
export async function openWithTasks(
  page: Page,
  fake: FakeSetup,
  state: Record<string, unknown> = {},
  { newChat = true, signedIn = false }: { newChat?: boolean; signedIn?: boolean } = {},
): Promise<void> {
  if (signedIn) await signIn(page.context())
  await page.addInitScript(
    ({ seed, version, fake }) => {
      ;(window as unknown as { __HUMM_E2E_TASKS__: unknown }).__HUMM_E2E_TASKS__ = fake
      if (localStorage.getItem("e2e-seeded")) return
      localStorage.setItem("hummingbird-storage", JSON.stringify({ state: seed, version }))
      localStorage.setItem("e2e-seeded", "1")
    },
    { seed: { chatBackend: "python-runs", chatModel: HAIKU, ...state }, version: STORE_VERSION, fake },
  )
  await page.goto("/")
  if (newChat) await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
  // The fake is loaded after hydration.
  await expect.poll(() => page.evaluate(() => !!window.__hummTasksFake)).toBe(true)
}

export async function setFake(page: Page, patch: FakeSetup): Promise<void> {
  await page.evaluate((p) => window.__hummTasksFake!.set(p as never), patch)
}

export interface Call {
  op: string
  args: unknown[]
}

export async function calls(page: Page, op?: string): Promise<Call[]> {
  const all = (await page.evaluate(() => window.__hummTasksFake!.calls())) as Call[]
  return op ? all.filter((c) => c.op === op) : all
}

/** The launches' `TaskRequestInput`s and options. */
export async function launches(page: Page): Promise<{ input: Json; opts: Json | null }[]> {
  return (await calls(page, "launch")).map((c) => ({ input: c.args[0] as Json, opts: c.args[1] as Json | null }))
}

export const panel = (page: Page): Locator =>
  page.locator("aside").filter({ has: page.getByRole("button", { name: "Close tasks panel" }) })

export const taskItem = (page: Page, title: string): Locator =>
  panel(page).getByRole("listitem", { name: `Task: ${title}` })

/** Open the Tasks panel from the chat header's button. */
export async function openPanel(page: Page): Promise<void> {
  if ((await panel(page).getAttribute("data-state")) === "expanded") return
  await page.getByRole("button", { name: /^Open tasks panel/ }).click()
  await expect(panel(page)).toHaveAttribute("data-state", "expanded")
}

export const taskToggle = (page: Page): Locator => page.getByRole("button", { name: "Task", exact: true })

/** Send with Enter: a toast can cover the Send button. */
export async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text)
  await composer(page).press("Enter")
}
