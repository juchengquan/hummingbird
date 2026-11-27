/**
 * The models agent-py serves (wave 10, Q119): its `GET /v1/models` — the
 * `config/models.json` ids it has a provider for, which of them run tasks,
 * its default, and whether `auto` runs there. The browser loads it once
 * (`@/client/api/served-models`); until then, or when it can't be read, the
 * model rules keep the built-in Anthropic list (`@/shared/backend-models`).
 *
 * A tiny observable value, no I/O: the client sets it, React reads it
 * through `useSyncExternalStore`. The server never sets it.
 */

export interface ServedModels {
  /** Catalog ids agent-py can run, in catalog order. */
  ids: ReadonlySet<string>
  /** The ones background tasks can run on (they call tools, Q117). */
  tasks: ReadonlySet<string>
  /** agent-py's default (`AGENT_DEFAULT_MODEL`). */
  defaultModel: string
  /** Whether `auto` runs on agent-py's runs API. */
  auto: boolean
}

let current: ServedModels | null = null
let settled = false
let empty = false
const listeners = new Set<() => void>()

export function servedModels(): ServedModels | null {
  return current
}

/** Whether the first read has answered (with the list or not): until then a
 *  model the built-in list lacks may still be served, so nothing switches it. */
export function servedModelsSettled(): boolean {
  return settled
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function setServedModels(next: ServedModels | null): void {
  current = next
  settled = next !== null
  empty = false
  notify()
}

/**
 * Q131: agent-py answered its list and the list is **empty** — no model
 * provider is configured on this deploy (no provider key at all). Distinct
 * from a list that could not be read (offline, an error, a malformed body),
 * which keeps the built-in list and stays `false`. On agent-py's backends
 * the picker and the chat then say so and refuse to send
 * (`NO_MODEL_PROVIDER_MESSAGE`); the model rules still keep the built-in
 * list (`servedModels()` stays null), so nothing is switched around.
 */
export function noModelProvider(): boolean {
  return empty
}

export function markNoModelProvider(): void {
  if (empty && settled) return
  current = null
  empty = true
  settled = true
  notify()
}

/** Shown in the model picker and the chat, and as a send's refusal. */
export const NO_MODEL_PROVIDER_MESSAGE = "No model provider is configured on this deploy."
/** Where an admin looks next (agent-py reads the provider keys). */
export const NO_MODEL_PROVIDER_HINT =
  "Set a provider key for agent-py — see Model providers in the user manual (docs/user-manual/23-model-providers.md)."

export function markServedModelsSettled(): void {
  if (settled) return
  settled = true
  notify()
}

export function subscribeServedModels(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A `/v1/models` body, or null when it isn't one — or lists nothing: a
 *  deploy without any provider key runs nothing; the model rules keep the
 *  built-in list then, and `isEmptyModelList` tells that case apart (Q131). */
export function parseServedModels(body: unknown): ServedModels | null {
  if (typeof body !== "object" || body === null) return null
  const { models, defaultModel, auto } = body as Record<string, unknown>
  if (!Array.isArray(models) || typeof defaultModel !== "string" || typeof auto !== "boolean") return null
  const ids: string[] = []
  const tasks: string[] = []
  for (const m of models) {
    if (typeof m !== "object" || m === null) return null
    const { id, tasks: runsTasks } = m as Record<string, unknown>
    if (typeof id !== "string" || typeof runsTasks !== "boolean") return null
    ids.push(id)
    if (runsTasks) tasks.push(id)
  }
  if (ids.length === 0) return null
  return { ids: new Set(ids), tasks: new Set(tasks), defaultModel, auto }
}

/** Whether `body` is a well-formed `/v1/models` answer listing no model —
 *  a deploy with no model provider (Q131). */
export function isEmptyModelList(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false
  const { models, defaultModel, auto } = body as Record<string, unknown>
  return Array.isArray(models) && models.length === 0 && typeof defaultModel === "string" && typeof auto === "boolean"
}
