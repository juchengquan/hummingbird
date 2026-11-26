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
  notify()
}

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
 *  deploy without any provider key (or on the stub harness) runs nothing,
 *  and the built-in list keeps the picker usable, as before wave 10. */
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
