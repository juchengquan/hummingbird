import { expect, test, type Page } from "@playwright/test"

import { CREDENTIAL, SERVER, createPersona, openWithLocalServer, sendAsPersona } from "./support/persona"
import { composer, isStartRequest, steerRuns, stopButton } from "./support/runs"

/**
 * Q52: a turn remembers its persona, so every way of sending it again
 * (Regenerate, Edit, Retry, the automatic network retry, a UI card's
 * answer) keeps the persona's prompt, model and MCP allow-list.
 */

const PROMPT = "Answer as the e2e persona."
const MODEL = "anthropic/claude-haiku-4.5"

type Backend = "ts" | "python-runs"
type Reply = "ok" | "error" | "offline-once" | "card"

interface Sent {
  allow: string[] | undefined
  prompt: string
  /** Only on Next: `steerRuns` strips a run's model. */
  model: string | undefined
  hasCredential: boolean
}

const frames = (...items: object[]) => items.map((i) => `data: ${JSON.stringify(i)}\n\n`).join("")

/** Stand in for both backends' replies and record every chat send. */
async function backends(page: Page, reply: Reply): Promise<Sent[]> {
  const sent: Sent[] = []
  page.on("request", (request) => {
    const next = request.method() === "POST" && request.url().endsWith("/api/chat")
    if (!next && !isStartRequest(request)) return
    const body = request.postDataJSON()
    const options = next ? body : (body.forwardedProps ?? {})
    sent.push({
      allow: options.allowedMcpServerIds,
      prompt: (next ? options.workspaceSystemPrompt : options.systemPrompt) ?? "",
      model: next ? options.model : undefined,
      hasCredential: (request.postData() ?? "").includes(CREDENTIAL),
    })
  })
  await steerRuns(page, reply === "error" ? { outcome: "fail" } : {})
  let calls = 0
  await page.route("**/api/chat", async (route) => {
    calls += 1
    if (reply === "error") return route.fulfill({ status: 500, json: { code: "provider", message: "e2e" } })
    if (reply === "offline-once" && calls === 1) return route.abort("failed")
    const card = {
      type: "data-ui",
      data: {
        id: "card-1",
        kind: "choice",
        props: { prompt: "Which one?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
      },
    }
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      // The AI SDK UI message stream `/api/chat` speaks.
      body: `${frames(
        { type: "text-delta", id: "t1", delta: "Fake reply" },
        ...(reply === "card" && calls === 1 ? [card] : []),
      )}data: [DONE]\n\n`,
    })
  })
  return sent
}

async function personaTurn(page: Page, backend: Backend, sent: Sent[], allowServer = false) {
  await openWithLocalServer(page, backend)
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
  for (const backend of ["ts", "python-runs"] as const) {
    for (const action of ACTIONS) {
      for (const allowServer of [false, true]) {
        test(`${backend}: ${action.name} (${allowServer ? "server ticked" : "empty list"})`, async ({ page }) => {
          const sent = await backends(page, action.reply)
          await personaTurn(page, backend, sent, allowServer)
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
  }

  test("ts: the automatic retry after a network error", async ({ page }) => {
    const sent = await backends(page, "offline-once")
    await personaTurn(page, "ts", sent)
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1]).toEqual(sent[0])
    expect(sent[1].allow).toEqual([])
  })

  test("ts: answering a card continues as the persona", async ({ page }) => {
    const sent = await backends(page, "card")
    await personaTurn(page, "ts", sent)
    await page.getByRole("button", { name: "Alpha", exact: true }).click()
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1]).toEqual(sent[0])
    expect(sent[1].allow).toEqual([])
  })

  test("ts: the record survives a reload", async ({ page }) => {
    const sent = await backends(page, "ok")
    await personaTurn(page, "ts", sent)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("hummingbird-storage") ?? ""))
      .toContain("Fake reply")
    await page.reload()
    await regenerate(page)
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1]).toEqual(sent[0])
    expect(sent[1].allow).toEqual([])
  })

  test("ts: a deleted persona's list still holds", async ({ page }) => {
    const sent = await backends(page, "ok")
    await personaTurn(page, "ts", sent)
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

  test("ts: a turn without a persona stays unrestricted", async ({ page }) => {
    const sent = await backends(page, "ok")
    await openWithLocalServer(page, "ts")
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
