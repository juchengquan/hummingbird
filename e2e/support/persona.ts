import { expect, type Page } from "@playwright/test"

import { STORE_VERSION } from "../../lib/client/hooks/store/migrate"

import { composer } from "./runs"

export const SERVER = {
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

export const CREDENTIAL = "Bearer e2e-local-mcp-credential"

/** Open a chat on `chatBackend`, in a workspace with one local-mode server
 *  (with a saved credential). Seeds once per browser context, so a reload
 *  or a second tab sees what the app saved. */
export async function openWithLocalServer(page: Page, chatBackend: "ts" | "python-runs") {
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

export async function createPersona(
  page: Page,
  { allowServer, systemPrompt, model }: { allowServer: boolean; systemPrompt?: string; model?: string },
) {
  await composer(page).fill("/personas ")
  await composer(page).press("Enter")
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "New persona" }).click()
  await dialog.getByPlaceholder("Code reviewer").fill("Helper")

  if (systemPrompt) await dialog.getByPlaceholder(/You review pull-request diffs/).fill(systemPrompt)
  if (model) await dialog.getByPlaceholder("claude-sonnet-4-6").fill(model)

  const choice = dialog.getByRole("button", { name: /Notes MCP/ })
  await expect(choice).toContainText("not available in tasks")
  if (allowServer) await choice.click()

  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
}

export async function sendAsPersona(page: Page) {
  await composer(page).fill("/helper hello")
  await composer(page).press("Enter")
}
