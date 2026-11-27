/**
 * The models agent-py serves (wave 10, Q114–Q119) on the real stack. The
 * stack gives agent-py an Ollama host — the scripted model server, spoken to
 * in the Anthropic Messages format like every provider — besides its
 * Anthropic key, so it serves a model the built-in `anthropic/*` list lacks.
 * The picker offers what `GET /v1/models` lists, a pick of it survives a
 * reload (nothing switches it before the list arrives), and a turn on it
 * reaches that provider with the id it knows (`llama3.1:8b`); the follow-up
 * chips stay on the default model.
 */
import { expect, test, type Page } from "./guard"

import { STORE_VERSION } from "../lib/client/hooks/store/migrate"

const FAKE = "http://127.0.0.1:8172", AGENT = "http://127.0.0.1:8171"
const LLAMA = "ollama/llama3.1:8b"
const composer = (p: Page) => p.getByPlaceholder("Ask me anything!")

type Request = { model: string; messages: { content: unknown }[] }
const sent = async (): Promise<Request[]> => JSON.parse((await (await fetch(`${FAKE}/state`)).json()).all_text)

async function open(page: Page, chatModel: string) {
  const id = crypto.randomUUID(), now = new Date().toISOString()
  const seed = { chatBackend: "python-runs", chatModel, workspaces: [{ id, name: "Models", createdAt: now, updatedAt: now }], activeWorkspaceId: id, conversations: [] }
  await page.addInitScript(({ seed, version }) => {
    if (localStorage.getItem("e2e-seeded")) return
    localStorage.setItem("hummingbird-storage", JSON.stringify({ state: seed, version }))
    localStorage.setItem("e2e-seeded", "1")
  }, { seed, version: STORE_VERSION })
  await page.goto("/")
  await page.getByRole("button", { name: "New chat" }).click()
  await composer(page).waitFor()
}

test("GET /v1/models lists what the stack has providers for", async () => {
  const body = await (await fetch(`${AGENT}/v1/models`)).json()
  const ids = body.models.map((m: { id: string }) => m.id)
  expect(ids).toContain("anthropic/claude-haiku-4.5")
  expect(ids).toContain(LLAMA)
  // No Gateway key here, and the stack's http Minimax URL is refused.
  expect(ids).not.toContain("openai/gpt-5.5")
  expect(ids).not.toContain("minimax/minimax-m3.1-flash")
})

test("a model only agent-py's list has: offered, kept on reload, and run on its provider", async ({ page }) => {
  await open(page, LLAMA)
  const picker = page.getByRole("combobox", { name: "Model" })
  await expect(picker).toHaveText(/Llama 3\.1 8B/)
  await picker.click()
  await expect(page.getByRole("option", { name: "Llama 3.1 8B (Ollama)" })).toBeVisible()
  await expect(page.getByRole("option", { name: "Claude Haiku 4.5" })).toBeVisible()
  await expect(page.getByRole("option", { name: "GPT-5.5" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  const before = (await sent()).length
  const ask = `models-${crypto.randomUUID().slice(0, 8)} hello`
  await composer(page).fill(ask)
  await composer(page).press("Enter")
  await expect(page.getByText("ok", { exact: true }).last()).toBeVisible()
  const turn = (await sent()).slice(before).filter((r) => JSON.stringify(r.messages).includes(ask))
  expect(turn.map((r) => r.model)).toContain("llama3.1:8b")

  await page.reload()
  await composer(page).waitFor()
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(/Llama 3\.1 8B/)
  await expect(page.getByText(/isn't available/)).toHaveCount(0)
})

test("a model agent-py has no provider for is switched to one it serves, with a note", async ({ page }) => {
  await open(page, "openai/gpt-5.5")
  await expect(page.getByText(/GPT-5\.5 isn't available on agent-py/)).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Model" })).not.toHaveText(/GPT-5\.5/)
})
