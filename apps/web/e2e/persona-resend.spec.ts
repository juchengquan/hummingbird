import { expect, test, type Page } from "@playwright/test"

import { AGENT_PY_ORIGIN } from "./support/env"
import { CREDENTIAL, SERVER, createPersona, openWithLocalServer, sendAsPersona } from "./support/persona"
import { composer, isStartRequest, steerRuns, stopButton } from "./support/runs"

/**
 * Q52: a turn remembers its persona, so every way of sending it again
 * (Regenerate, Edit, Retry, the automatic network retry, a UI card's
 * answer) keeps the persona's prompt, model and MCP allow-list.
 */

const PROMPT = "Answer as the e2e persona."
const MODEL = "anthropic/claude-haiku-4.5"

type Reply = "ok" | "error" | "offline-once" | "card"

interface Sent {
  allow: string[] | undefined
  prompt: string
  hasCredential: boolean
  /** A resume of a paused run (an answered card). */
  resume: boolean
}

/** Steer the stub harness and record every run start / resume. */
async function runs(page: Page, reply: Reply): Promise<Sent[]> {
  const sent: Sent[] = []
  page.on("request", (request) => {
    if (!isStartRequest(request)) return
    const body = request.postDataJSON()
    const options = body.forwardedProps ?? {}
    sent.push({
      allow: options.allowedMcpServerIds,
      prompt: options.systemPrompt ?? "",
      hasCredential: (request.postData() ?? "").includes(CREDENTIAL),
      resume: typeof options.previousRunId === "string",
    })
  })
  await steerRuns(
    page,
    reply === "error" ? { outcome: "fail" } : reply === "card" ? { outcome: "interrupt" } : {},
    reply === "card" ? { resume: {} } : undefined,
  )
  if (reply === "offline-once") {
    // Registered after `steerRuns`, so it is asked first: the first start
    // never reaches agent-py (a network error); the rest go through.
    let starts = 0
    await page.route(`${AGENT_PY_ORIGIN}/v1/runs`, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      starts += 1
      return starts === 1 ? route.abort("failed") : route.fallback()
    })
  }
  return sent
}

/** What a resend must carry again: the persona's recipe, not the resume. */
const recipe = ({ allow, prompt, hasCredential }: Sent) => ({ allow, prompt, hasCredential })

async function personaTurn(page: Page, sent: Sent[], allowServer = false) {
  await openWithLocalServer(page)
  await createPersona(page, { allowServer, systemPrompt: PROMPT, model: MODEL })
  await sendAsPersona(page)
  await expect.poll(() => sent.length).toBeGreaterThan(0)
  await expect(stopButton(page)).toBeHidden()
}

async function editLastMessage(page: Page) {
  await page.getByRole("button", { name: "Edit message" }).last().click({ force: true })
  const box = page.locator("textarea").filter({ hasText: "hello" }).first()
  await box.fill("hello again")
  await box.press("Enter")
}

const regenerate = (page: Page) => page.getByRole("button", { name: "Retry response" }).last().click({ force: true })

const ACTIONS: { name: string; reply: Reply; run: (page: Page) => Promise<void> }[] = [
  { name: "Regenerate", reply: "ok", run: regenerate },
  { name: "Edit", reply: "ok", run: editLastMessage },
  {
    name: "Retry",
    reply: "error",
    run: (page) => page.getByRole("button", { name: /^\s*Retry\s*$/ }).first().click(),
  },
]

test.describe("a resend keeps the turn's persona", () => {
  for (const action of ACTIONS) {
    for (const allowServer of [false, true]) {
      test(`${action.name} (${allowServer ? "server ticked" : "empty list"})`, async ({ page }) => {
        const sent = await runs(page, action.reply)
        await personaTurn(page, sent, allowServer)
        await action.run(page)
        await expect.poll(() => sent.length).toBe(2)
        const [original, again] = sent
        expect(original.allow).toEqual(allowServer ? [SERVER.id] : [])
        expect(original.prompt).toContain(PROMPT)
        expect(again).toEqual(original)
        expect(again.hasCredential).toBe(allowServer)
      })
    }
  }

  test("the automatic retry after a network error", async ({ page }) => {
    const sent = await runs(page, "offline-once")
    await personaTurn(page, sent)
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1]).toEqual(sent[0])
    expect(sent[1].allow).toEqual([])
  })

  test("answering a card continues as the persona", async ({ page }) => {
    const sent = await runs(page, "card")
    await personaTurn(page, sent)
    await page.getByRole("button", { name: "Approve", exact: true }).click()
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1].resume).toBe(true)
    expect(recipe(sent[1])).toEqual(recipe(sent[0]))
    expect(sent[1].allow).toEqual([])
  })

  test("the record survives a reload", async ({ page }) => {
    const sent = await runs(page, "ok")
    await personaTurn(page, sent)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("hummingbird-storage") ?? ""))
      .toContain("Stub reply to:")
    await page.reload()
    await regenerate(page)
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1]).toEqual(sent[0])
    expect(sent[1].allow).toEqual([])
  })

  test("a deleted persona's list still holds", async ({ page }) => {
    const sent = await runs(page, "ok")
    await personaTurn(page, sent)
    await composer(page).fill("/personas ")
    await composer(page).press("Enter")
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: "Edit", exact: true }).click()
    await dialog.getByRole("button", { name: "Delete", exact: true }).click()
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()

    await regenerate(page)
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1].allow).toEqual([])
    expect(sent[1].hasCredential).toBe(false)
    expect(sent[1].prompt).not.toContain(PROMPT)
  })

  test("a turn without a persona stays unrestricted", async ({ page }) => {
    const sent = await runs(page, "ok")
    await openWithLocalServer(page)
    await composer(page).fill("hello")
    await composer(page).press("Enter")
    await expect.poll(() => sent.length).toBe(1)
    await expect(stopButton(page)).toBeHidden()
    await regenerate(page)
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1].allow).toBeUndefined()
    expect(sent[1].hasCredential).toBe(true)
  })
})
