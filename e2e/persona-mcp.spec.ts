import { expect, test, type Page } from "@playwright/test"

import { STORE_VERSION } from "../lib/client/hooks/store/migrate"

import { composer, isStartRequest, steerRuns } from "./support/runs"

/**
 * Q50: a persona's MCP allow-list filters local-mode servers as well as
 * cloud-mode ones (Q48), so `/personas` must offer both. Driven through
 * the dialog, down to what each chat backend is sent. Q51: a resume from
 * a page that didn't start the run (reload, other tab) keeps the list.
 */

const SERVER = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "default",
  name: "Notes MCP",
  url: "https://mcp.example.com/mcp",
  transport: "http",
  credentialMode: "local",
  enabled: true,
  capabilities: { tools: [{ name: "search", description: "Search notes", inputSchema: { type: "object" } }] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

const CREDENTIAL = "Bearer e2e-local-mcp-credential"

/** Open a chat on `chatBackend`, in a workspace with one local-mode server
 *  (with a saved credential). Seeds once per browser context, so a reload
 *  or a second tab sees what the app saved. */
async function openWithLocalServer(page: Page, chatBackend: "ts" | "python-runs") {
  await page.addInitScript(
    ({ state, version, creds }) => {
      if (localStorage.getItem("e2e-seeded")) return
      localStorage.setItem("hummingbird-storage", JSON.stringify({ state, version }))
      localStorage.setItem("hummingbird-mcp-creds-v1", JSON.stringify(creds))
      localStorage.setItem("e2e-seeded", "1")
    },
    {
      state: { chatBackend, mcpServers: [SERVER] },
      version: STORE_VERSION,
      creds: { [SERVER.id]: { type: "bearer", headers: { Authorization: CREDENTIAL } } },
    },
  )
  await page.goto("/")
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
}

async function createPersona(page: Page, { allowServer }: { allowServer: boolean }) {
  await composer(page).fill("/personas ")
  await composer(page).press("Enter")
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "New persona" }).click()
  await dialog.getByPlaceholder("Code reviewer").fill("Helper")

  const choice = dialog.getByRole("button", { name: /Notes MCP/ })
  await expect(choice).toContainText("not available in tasks")
  if (allowServer) await choice.click()

  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
}

async function sendAsPersona(page: Page) {
  await composer(page).fill("/helper hello")
  await composer(page).press("Enter")
}

test.describe("persona MCP allow-list", () => {
  test("Next chat: a ticked local server is in the allow-list", async ({ page }) => {
    await page.route("**/api/chat", (route) =>
      route.fulfill({ status: 500, json: { code: "provider", message: "e2e: not dispatched" } }),
    )
    await openWithLocalServer(page, "ts")
    await createPersona(page, { allowServer: true })

    const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/chat"))
    await sendAsPersona(page)
    const body = (await sent).postDataJSON()
    expect(body.allowedMcpServerIds).toEqual([SERVER.id])
    expect(body.mcpServers.map((s: { id: string }) => s.id)).toEqual([SERVER.id])
  })

  test("runs: a ticked local server is sent with the run", async ({ page }) => {
    const { starts } = await steerRuns(page, {})
    await openWithLocalServer(page, "python-runs")
    await createPersona(page, { allowServer: true })

    await sendAsPersona(page)
    await expect.poll(() => starts.length).toBe(1)
    expect(starts[0].forwardedProps?.allowedMcpServerIds).toEqual([SERVER.id])
    expect(starts[0].forwardedProps?.localMcpServers).toMatchObject([{ id: SERVER.id }])
  })

  test("runs: an empty allow-list still means no MCP", async ({ page }) => {
    const { starts } = await steerRuns(page, {})
    await openWithLocalServer(page, "python-runs")
    await createPersona(page, { allowServer: false })

    await sendAsPersona(page)
    await expect.poll(() => starts.length).toBe(1)
    expect(starts[0].forwardedProps?.allowedMcpServerIds).toEqual([])
    expect(starts[0].forwardedProps?.localMcpServers).toBeUndefined()
  })

  for (const answeredFrom of ["after a reload", "in another tab"] as const) {
    for (const allowServer of [false, true]) {
      test(`runs: answered ${answeredFrom}, the list holds (${allowServer ? "server ticked" : "empty"})`, async ({
        page,
        context,
      }) => {
        await steerRuns(page, { outcome: "interrupt" })
        await openWithLocalServer(page, "python-runs")
        await createPersona(page, { allowServer })
        await sendAsPersona(page)
        await page.getByText("Approve the stub action?").waitFor()
        // Wait for the turn to be on disk before another page reads it.
        await expect
          .poll(() => page.evaluate(() => localStorage.getItem("hummingbird-storage") ?? ""))
          .toContain("Stub reply to")

        let answering = page
        if (answeredFrom === "after a reload") await page.reload()
        else {
          answering = await context.newPage()
          await steerRuns(answering, { outcome: "interrupt" })
          await answering.goto("/")
        }
        await answering.getByText("Approve the stub action?").waitFor()

        const resume = answering.waitForRequest(isStartRequest)
        await answering.getByRole("button", { name: "Approve", exact: true }).click()
        const request = await resume
        const sent = request.postDataJSON()
        expect(sent.forwardedProps.allowedMcpServerIds).toEqual(allowServer ? [SERVER.id] : [])
        if (allowServer) {
          expect(sent.forwardedProps.localMcpServers).toMatchObject([{ id: SERVER.id }])
        } else {
          expect(sent.forwardedProps.localMcpServers).toBeUndefined()
          // Never sent, not just ignored by the server.
          expect(request.postData()).not.toContain(CREDENTIAL)
        }
      })
    }
  }
})
