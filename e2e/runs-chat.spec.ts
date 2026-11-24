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
  type StartRunBody,
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

    // The route handler records the start after the request event fires.
    await expect.poll(() => starts.length).toBe(2)
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

  test("an answer a failed resume already applied can't be given again (Q63)", async ({ page, browser }) => {
    // The resume applies the answer, then fails (a model error after the tool ran).
    const steering = { outcome: "interrupt" } as const
    const resume = { outcome: "fail" } as const
    await steerRuns(page, steering, { resume })
    await openChat(page)
    await sendMessage(page, "applied smoke")
    await page.getByText("Approve the stub action?").waitFor()
    // The paused turn (message, pointer, run token) is on disk.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("hummingbird-storage") ?? ""))
      .toContain("Stub reply to: applied smoke")
    const saved = await page.evaluate(() => JSON.stringify({ ...localStorage }))

    // Another browser holding the same run shows the same question. (A
    // second tab of this browser would not keep it: cross-tab sync brings
    // over the failed answer's bubble, which replaces the cards.)
    const elsewhere = await browser.newContext()
    try {
      const other = await elsewhere.newPage()
      await other.addInitScript((items) => {
        if (localStorage.getItem("e2e-cloned")) return
        for (const [key, value] of Object.entries(JSON.parse(items) as Record<string, string>)) {
          localStorage.setItem(key, value)
        }
        localStorage.setItem("e2e-cloned", "1")
      }, saved)
      const otherLog = await steerRuns(other, steering, { resume })
      await other.goto("/")
      await other.getByText("Approve the stub action?").waitFor()

      // This tab answers: applied, then the run fails.
      const first = page.waitForResponse((r) => isStartRequest(r.request()))
      await page.getByRole("button", { name: "Approve", exact: true }).click()
      expect((await first).status()).toBe(200)
      await expect(page.getByText("Provider error")).toBeVisible()

      // The other browser's answer is refused: its card goes, and the bubble says why.
      const refused = other.waitForResponse((r) => isStartRequest(r.request()))
      await other.getByRole("button", { name: "Approve", exact: true }).click()
      const response = await refused
      expect(response.status()).toBe(409)
      expect(((await response.json()) as { code: string }).code).toBe("run_answer_applied")
      await expect(other.getByText("Approve the stub action?")).toBeHidden()
      await expect(other.getByText("This answer was already acted on")).toBeVisible()
      await expect(other.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0)
      // Nothing restores it on a reload.
      await other.reload()
      await expect(other.getByText("This answer was already acted on")).toBeVisible()
      await expect(other.getByText("Approve the stub action?")).toBeHidden()

      // Its Retry sends the turn again as a new message: a new run, not a resume.
      const resend = other.waitForRequest(isStartRequest)
      await other.getByRole("button", { name: "Retry" }).click()
      const again = (await resend).postDataJSON() as StartRunBody
      expect(again.resume ?? []).toHaveLength(0)
      expect(again.forwardedProps?.previousRunId).toBeUndefined()
      expect(again.messages.at(-1)).toMatchObject({ role: "user", content: "applied smoke" })
      await expect.poll(() => otherLog.starts.at(-1)?.runId).toBe(again.runId)
    } finally {
      await elsewhere.close()
    }
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
