import { expect, test } from "@playwright/test"

import { AGENT_PY_ORIGIN } from "./support/env"
import {
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
 * and sending a turn on `/v1/runs` (the only chat path, wave 13).
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

test("the app boots and sends a turn on /v1/runs", async ({ page }) => {
  await steerRuns(page, {})
  const turnRequests: string[] = []
  page.on("request", (r) => {
    const url = r.url()
    if (r.method() === "POST" && (isStartRequest(r) || /\/(api|v1)\/chat$/.test(new URL(url).pathname))) {
      turnRequests.push(new URL(url).pathname)
    }
  })
  await openChat(page)

  // There is no backend setting to persist any more (store v37, Q145).
  const stored = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem("hummingbird-storage") ?? "{}").state ?? {},
  )
  expect("chatBackend" in stored).toBe(false)

  await sendMessage(page, "hello from e2e")
  await expect(page.getByText("hello from e2e").first()).toBeVisible()
  await expect(assistantBubbles(page).last()).toContainText("Stub reply to: hello from e2e")

  expect(turnRequests).toEqual(["/v1/runs"])
})
