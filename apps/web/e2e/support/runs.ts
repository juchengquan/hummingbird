import type { Locator, Page, Request } from "@playwright/test"

import { AGENT_PY_ORIGIN } from "./env"

/** The stub harness's steering knobs (`agent_py.runs.stub_harness`). */
export interface StubSteering {
  outcome?: "succeed" | "fail" | "interrupt"
  steps?: number
  stepDelayMs?: number
  /** A resume fails before applying its answers (they stay answerable);
   *  without it a resume steered to `fail` fails after applying them (Q63). */
  failBeforeApplying?: boolean
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
 * doesn't interrupt again — or to `opts.resume` when given. Routes
 * survive reloads.
 */
export async function steerRuns(
  page: Page,
  steering: StubSteering,
  opts: { resume?: StubSteering } = {},
): Promise<RunsLog> {
  const log: RunsLog = { starts: [], tokens: new Map() }
  await page.route(`${AGENT_PY_ORIGIN}/v1/runs`, async (route) => {
    const request = route.request()
    if (request.method() !== "POST") return route.continue()
    const body = request.postDataJSON() as StartRunBody
    const forwardedProps = { ...(body.forwardedProps ?? {}) }
    delete forwardedProps.model
    forwardedProps.conformance = body.resume?.length
      ? (opts.resume ?? { ...steering, outcome: "succeed" })
      : steering
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
  /Authentication failed|Sign in required|Rate limited|Conversation too long|Model unavailable|Model not available on this server|Attachment can't be sent|Provider error|Network error|This answer was already acted on|Something went wrong/

export async function sendMessage(page: Page, text: string): Promise<void> {
  await composer(page).fill(text)
  await page.getByRole("button", { name: "Send message" }).click()
}

/**
 * Load the app, start a new chat (a fresh
 * conversation → a fresh run thread, so specs never share one) and wait
 * for the composer.
 */
export async function openChat(page: Page): Promise<void> {
  await page.goto("/")
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
}
