import { expect, test } from "@playwright/test"

import { AGENT_PY_ORIGIN } from "./support/env"
import {
  RUNS_WIRED,
  assistantBubbles,
  isStartRequest,
  openChat,
  sendMessage,
  steerRuns,
} from "./support/runs"

/**
 * Always on: the plumbing the runs specs stand on — both servers up,
 * agent-py reachable from the app's origin (CORS, `X-Run-Token` exposed),
 * the stub harness steerable through `page.route`, and the app booting
 * with "agent-py (runs)" selected and sending a turn.
 */

test("agent-py answers a stub run cross-origin, steered by the route", async ({ page }) => {
  await openChat(page)
  const { starts } = await steerRuns(page, { steps: 2 })

  const res = await page.evaluate(async (origin) => {
    const r = await fetch(`${origin}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        threadId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        messages: [{ id: crypto.randomUUID(), role: "user", content: "ping" }],
        forwardedProps: { model: "not/an-allowed-model" },
      }),
    })
    return { status: r.status, runToken: r.headers.get("x-run-token"), body: await r.text() }
  }, AGENT_PY_ORIGIN)

  expect(res.status).toBe(200)
  // Anonymous run: its token must be readable cross-origin (expose_headers).
  expect(res.runToken).toBeTruthy()
  expect(res.body).toContain("RUN_STARTED")
  expect(res.body).toContain("Stub reply to: ping")
  expect(res.body).toContain(" (step 2)")
  expect(res.body).toContain("RUN_FINISHED")
  // The route rewrote the body: steering in, the disallowed model out.
  expect(starts).toHaveLength(1)
  expect(starts[0].forwardedProps).toEqual({ conformance: { steps: 2 } })
})

test("the app boots with agent-py (runs) selected and sends a turn", async ({ page }) => {
  await steerRuns(page, {})
  const turnRequests: string[] = []
  page.on("request", (r) => {
    const url = r.url()
    if (r.method() === "POST" && (isStartRequest(r) || /\/(api|v1)\/chat$/.test(new URL(url).pathname))) {
      turnRequests.push(new URL(url).pathname)
    }
  })
  await openChat(page)

  // The selection survived hydration + migrations.
  const backend = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem("hummingbird-storage") ?? "{}").state?.chatBackend,
  )
  expect(backend).toBe("python-runs")

  await sendMessage(page, "hello from e2e")
  await expect(page.getByText("hello from e2e").first()).toBeVisible()
  // Some assistant answer arrives: the stub's once chat is on runs; before
  // that (signed out, no AI gateway key) the in-Next route's mock reply.
  await expect(assistantBubbles(page).last()).not.toBeEmpty()

  expect(turnRequests.length).toBeGreaterThan(0)
  if (RUNS_WIRED) expect(turnRequests[0]).toBe("/v1/runs")
})
