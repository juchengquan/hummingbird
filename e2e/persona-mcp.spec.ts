import { expect, test, type Page } from "@playwright/test"

import { STORE_VERSION } from "../lib/client/hooks/store/migrate"

import { composer, steerRuns } from "./support/runs"

/**
 * Q50: a persona's MCP allow-list filters local-mode servers as well as
 * cloud-mode ones (Q48), so `/personas` must offer both. Driven through
 * the dialog, down to what each chat backend is sent.
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

/** Open a chat on `chatBackend`, in a workspace with one local-mode server. */
async function openWithLocalServer(page: Page, chatBackend: "ts" | "python-runs") {
  await page.addInitScript(
    ({ state, version }) => {
      localStorage.setItem("hummingbird-storage", JSON.stringify({ state, version }))
    },
    { state: { chatBackend, mcpServers: [SERVER] }, version: STORE_VERSION },
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
      route.fulfill({ status: 500, json: { error: { code: "provider", message: "e2e: not dispatched" } } }),
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
})
