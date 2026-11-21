import type { Locator, Page, Request } from "@playwright/test"

import { STORE_VERSION } from "../../lib/client/hooks/store/migrate"
import { RUNS_CHAT_ENABLED } from "../../lib/client/runs/config"

import { AGENT_PY_ORIGIN } from "./env"

/** `STORE_STORAGE_KEY` (lib/client/hooks/use-store.ts — not imported: it pulls the whole store). */
const STORE_STORAGE_KEY = "hummingbird-storage"

/**
 * Whether the specs that need chat to send on `/v1/runs` (wave 4b-A) and
 * the answer cards (4b-B) run. Follows the app's own switch: 4b-A flips
 * `RUNS_CHAT_ENABLED` to `true` in the change that wires chat onto runs,
 * and these specs turn on with it. `E2E_RUNS_WIRED=1` / `=0` overrides.
 */
export const RUNS_WIRED =
  process.env.E2E_RUNS_WIRED === "1" ||
  (process.env.E2E_RUNS_WIRED !== "0" && RUNS_CHAT_ENABLED)

export const RUNS_WIRED_REASON =
  "chat isn't on /v1/runs yet (RUNS_CHAT_ENABLED is false): needs wave 4b-A/B — set E2E_RUNS_WIRED=1 to force"

/** The stub harness's steering knobs (`agent_py.runs.stub_harness`). */
export interface StubSteering {
  outcome?: "succeed" | "fail" | "interrupt"
  steps?: number
  stepDelayMs?: number
}

/**
 * Select "agent-py (runs)" before the app loads: merge
 * `chatBackend: "python-runs"` into the persisted store, keeping whatever
 * is there (this runs again on every reload, so it must not reset the
 * conversation a reload spec is about to rejoin).
 */
export async function selectRunsBackend(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, version }) => {
      let value: { state?: Record<string, unknown>; version?: number } = {}
      try {
        value = JSON.parse(window.localStorage.getItem(key) ?? "{}") ?? {}
      } catch {
        value = {}
      }
      const state = value.state ?? {}
      if (state.chatBackend === "python-runs") return
      window.localStorage.setItem(
        key,
        JSON.stringify({ ...value, state: { ...state, chatBackend: "python-runs" }, version: value.version ?? version }),
      )
    },
    { key: STORE_STORAGE_KEY, version: STORE_VERSION },
  )
}

export interface StartRunBody {
  runId: string
  threadId: string
  messages: { id: string; role: string; content?: string }[]
  resume?: { interruptId: string; status?: string; payload?: unknown }[]
  forwardedProps?: Record<string, unknown> & { previousRunId?: string; conformance?: StubSteering }
}

export interface RunsLog {
  /** Every `POST /v1/runs` the page made (starts and resumes), as rewritten, in order. */
  starts: StartRunBody[]
  /** Anonymous runs' `X-Run-Token`s, by run id (from the start responses). */
  tokens: Map<string, string>
}

/**
 * Steer agent-py's stub harness from the browser side: every
 * `POST /v1/runs` the page makes is rewritten to carry
 * `forwardedProps.conformance = steering`, and loses `forwardedProps.model`
 * (the app's default model isn't on agent-py's `anthropic/*` allow-list →
 * `400 unknown_model`; the stub doesn't use a model anyway). A resume
 * (`resume[]` present) is steered to `succeed`, so answering an interrupt
 * doesn't interrupt again. Routes survive reloads.
 */
export async function steerRuns(page: Page, steering: StubSteering): Promise<RunsLog> {
  const log: RunsLog = { starts: [], tokens: new Map() }
  await page.route(`${AGENT_PY_ORIGIN}/v1/runs`, async (route) => {
    const request = route.request()
    if (request.method() !== "POST") return route.continue()
    const body = request.postDataJSON() as StartRunBody
    const forwardedProps = { ...(body.forwardedProps ?? {}) }
    delete forwardedProps.model
    forwardedProps.conformance = body.resume?.length ? { ...steering, outcome: "succeed" } : steering
    const rewritten = { ...body, forwardedProps }
    log.starts.push(rewritten)
    await route.continue({ postData: JSON.stringify(rewritten) })
  })
  page.on("response", async (response) => {
    if (!isStartRequest(response.request())) return
    const token = await response.headerValue("x-run-token").catch(() => null)
    const runId = (response.request().postDataJSON() as StartRunBody | null)?.runId
    if (token && runId) log.tokens.set(runId, token)
  })
  return log
}

const runPath = (suffix: string) =>
  new RegExp(`^${AGENT_PY_ORIGIN.replace(/[.]/g, "\\.")}/v1/runs/[0-9a-f-]{36}${suffix}(\\?.*)?$`)

/** `POST /v1/runs/{id}/cancel`. */
export function isCancelRequest(request: Request): boolean {
  return request.method() === "POST" && runPath("/cancel").test(request.url())
}

/** `GET /v1/runs/{id}/events` (a rejoin). */
export function isRejoinRequest(request: Request): boolean {
  return request.method() === "GET" && runPath("/events").test(request.url())
}

/** `POST /v1/runs` (a start or a resume). */
export function isStartRequest(request: Request): boolean {
  return request.method() === "POST" && request.url() === `${AGENT_PY_ORIGIN}/v1/runs`
}

// --- the chat UI --------------------------------------------------------

export const composer = (page: Page): Locator => page.getByPlaceholder("Ask me anything!")

/** Visible only while a turn streams (aria-hidden otherwise). */
export const stopButton = (page: Page): Locator => page.getByRole("button", { name: "Stop generating" })

/**
 * Assistant message bodies. `data-selection-scope="message-<id>"` is only
 * set on assistant bubbles (components/panels/chat-message.tsx); an
 * errored turn renders an ErrorBubble instead and has none.
 */
export const assistantBubbles = (page: Page): Locator => page.locator('[data-selection-scope^="message-"]')

/** The titles ErrorBubble can show (components/panels/error-bubble.tsx). */
export const ERROR_TITLE =
  /Authentication failed|Sign in required|Rate limited|Conversation too long|Model unavailable|Model not available on this server|Attachment can't be sent|Provider error|Network error|Something went wrong/

export async function sendMessage(page: Page, text: string): Promise<void> {
  await composer(page).fill(text)
  await page.getByRole("button", { name: "Send message" }).click()
}

/**
 * Load the app with "agent-py (runs)" selected, start a new chat (a fresh
 * conversation → a fresh run thread, so specs never share one) and wait
 * for the composer.
 */
export async function openChat(page: Page): Promise<void> {
  await selectRunsBackend(page)
  await page.goto("/")
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
}
