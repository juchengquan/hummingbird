import { expect, test, type APIRequestContext } from "@playwright/test"

import { AGENT_PY_ORIGIN } from "./support/env"
import {
  ERROR_TITLE,
  RUNS_WIRED,
  RUNS_WIRED_REASON,
  assistantBubbles,
  isCancelRequest,
  isRejoinRequest,
  isStartRequest,
  openChat,
  type RunsLog,
  sendMessage,
  steerRuns,
  stopButton,
} from "./support/runs"

/**
 * Chat on agent-py's `/v1/runs` in a real browser (Q39): send, Stop →
 * cancel, reload → rejoin, interrupt → answer → resume. The stub harness
 * answers `Stub reply to: <text>` (+ ` (step N)` per extra step), steered
 * per run by `steerRuns` (lib/client/runs/README.md § "For wave 4b-C").
 *
 * Gated on `RUNS_WIRED` (= the app's `RUNS_CHAT_ENABLED`): until wave
 * 4b-A wires chat sending onto runs and 4b-B adds the answer cards, chat
 * doesn't reach `/v1/runs` and these are reported as fixme.
 */

test.describe("chat on /v1/runs", () => {
  test.fixme(!RUNS_WIRED, RUNS_WIRED_REASON)

  test("send: the stub's reply streams into the assistant bubble", async ({ page }) => {
    const { starts } = await steerRuns(page, { steps: 2 })
    await openChat(page)

    await sendMessage(page, "send smoke")

    const bubble = assistantBubbles(page).last()
    await expect(bubble).toContainText("Stub reply to: send smoke (step 2)")
    await expect(stopButton(page)).toBeHidden()
    expect(count(await bubble.innerText(), "Stub reply to:")).toBe(1)
    await expect(page.getByText(ERROR_TITLE)).toHaveCount(0)

    expect(starts).toHaveLength(1)
    expect(starts[0].resume ?? []).toHaveLength(0)
    expect(starts[0].messages.at(-1)).toMatchObject({ role: "user", content: "send smoke" })
  })

  test("stop: cancels the run on the server and keeps the partial text", async ({ page, request }) => {
    const log = await steerRuns(page, { steps: 5, stepDelayMs: 2000 })
    await openChat(page)

    await sendMessage(page, "stop smoke")
    const bubble = assistantBubbles(page).last()
    await expect(bubble).toContainText("Stub reply to: stop smoke")
    expect(log.starts).toHaveLength(1)
    const runId = log.starts[0].runId

    const cancel = page.waitForRequest(isCancelRequest)
    await stopButton(page).click()
    expect((await cancel).url()).toBe(`${AGENT_PY_ORIGIN}/v1/runs/${runId}/cancel`)

    await expect(stopButton(page)).toBeHidden()
    await expect.poll(() => runStatus(request, log, runId)).toBe("cancelled")
    // The partial answer stays, the rest never comes, and it's no error.
    await expect(bubble).toContainText("Stub reply to: stop smoke")
    await expect(bubble).not.toContainText("(step 5)")
    await expect(page.getByText(ERROR_TITLE)).toHaveCount(0)
  })

  test("reload mid-run: rejoins and finishes the answer exactly once", async ({ page, request }) => {
    const log = await steerRuns(page, { steps: 3, stepDelayMs: 1000 })
    await openChat(page)

    await sendMessage(page, "rejoin smoke")
    await expect(assistantBubbles(page).last()).toContainText("Stub reply to: rejoin smoke")
    expect(log.starts).toHaveLength(1)
    const runId = log.starts[0].runId

    const rejoin = page.waitForRequest(isRejoinRequest)
    await page.reload()
    expect((await rejoin).url()).toContain(`/v1/runs/${runId}/events`)
    // Still the one run: the reload didn't start another.
    expect(log.starts).toHaveLength(1)

    const bubble = assistantBubbles(page).last()
    await expect(bubble).toContainText("Stub reply to: rejoin smoke (step 2) (step 3)")
    await expect(stopButton(page)).toBeHidden()
    await expect.poll(() => runStatus(request, log, runId)).toBe("succeeded")
    const text = await bubble.innerText()
    expect(count(text, "Stub reply to:")).toBe(1)
    expect(count(text, "(step 2)")).toBe(1)
    expect(count(text, "(step 3)")).toBe(1)
    await expect(assistantBubbles(page)).toHaveCount(1)
    await expect(page.getByText(ERROR_TITLE)).toHaveCount(0)
  })

  test("interrupt: the approval card resumes the run in the same bubble", async ({ page }) => {
    const { starts } = await steerRuns(page, { outcome: "interrupt" })
    await openChat(page)

    await sendMessage(page, "interrupt smoke")
    const bubble = assistantBubbles(page).last()
    await expect(bubble).toContainText("Stub reply to: interrupt smoke")
    await expect(page.getByText("Approve the stub action?")).toBeVisible()
    expect(starts).toHaveLength(1)
    const first = starts[0]

    const resume = page.waitForRequest(isStartRequest)
    await page.getByRole("button", { name: "Approve", exact: true }).click()
    await resume

    expect(starts).toHaveLength(2)
    const second = starts[1]
    expect(second.runId).not.toBe(first.runId)
    expect(second.threadId).toBe(first.threadId)
    expect(second.forwardedProps?.previousRunId).toBe(first.runId)
    expect(second.resume?.[0]?.interruptId).toBe(`${first.runId}:approve`)

    await expect(bubble).toContainText(`Resumed: ${first.runId}:approve=resolved`)
    await expect(bubble).toContainText("Stub reply to: interrupt smoke")
    await expect(page.getByText("Approve the stub action?")).toBeHidden()
    await expect(assistantBubbles(page)).toHaveCount(1)
    await expect(page.getByText(ERROR_TITLE)).toHaveCount(0)
  })
})

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** `GET /v1/runs/{id}` as the anonymous run's owner (its `X-Run-Token`) → its `status`. */
async function runStatus(request: APIRequestContext, log: RunsLog, runId: string): Promise<string> {
  const runToken = log.tokens.get(runId)
  if (!runToken) return "no X-Run-Token seen"
  const res = await request.get(`${AGENT_PY_ORIGIN}/v1/runs/${runId}`, { headers: { "x-run-token": runToken } })
  if (!res.ok()) return `http ${res.status()}`
  return ((await res.json()) as { status: string }).status
}
