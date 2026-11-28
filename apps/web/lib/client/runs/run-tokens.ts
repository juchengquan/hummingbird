import "client-only"

/**
 * Anonymous runs' capability tokens (`X-Run-Token`, Q20), kept per run in
 * localStorage so a reload can still rejoin, cancel or answer the run.
 *
 * `startRun` stores the token the response carries; every later call for
 * that run (`getRun`, `streamRunEvents`, `cancelRun`, an idempotent retry,
 * and a resume run answering it) reads it back here. A token is dropped
 * when its run ends for good — succeeded, failed or cancelled, or a 404
 * (the backend forgot the run, ~15 min after it ended, Q16) — and kept for
 * an interrupted run, whose answer presents it. Entries also age out after
 * `MAX_AGE_MS` since they were last saved.
 *
 * Signed-in runs never have a token: the Bearer JWT addresses them.
 */

const STORAGE_KEY = "humm.runTokens"

/** An anonymous run's log outlives its end by ~15 minutes; a waiting
 *  interrupt can't be answered after that either. One hour is generous. */
export const MAX_AGE_MS = 60 * 60_000

interface Entry {
  token: string
  savedAt: number
}

/** The storage seam (tests pass a Map-backed stand-in). */
export interface TokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultStorage(): TokenStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function read(storage: TokenStorage | null, now: number): Record<string, Entry> {
  if (!storage) return {}
  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const json = JSON.parse(raw) as unknown
    if (!json || typeof json !== "object" || Array.isArray(json)) return {}
    const out: Record<string, Entry> = {}
    for (const [runId, v] of Object.entries(json as Record<string, unknown>)) {
      const e = v as Partial<Entry> | null
      if (
        e &&
        typeof e.token === "string" &&
        typeof e.savedAt === "number" &&
        now - e.savedAt <= MAX_AGE_MS
      ) {
        out[runId] = { token: e.token, savedAt: e.savedAt }
      }
    }
    return out
  } catch {
    return {}
  }
}

function write(storage: TokenStorage | null, entries: Record<string, Entry>): void {
  if (!storage) return
  try {
    if (Object.keys(entries).length === 0) storage.removeItem(STORAGE_KEY)
    else storage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Private mode / quota — the run still works for this page's lifetime
    // (the transport keeps the token in memory); only a reload loses it.
  }
}

export function saveRunToken(
  runId: string,
  token: string,
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): void {
  const entries = read(storage, now)
  entries[runId] = { token, savedAt: now }
  write(storage, entries)
}

export function loadRunToken(
  runId: string,
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): string | null {
  return read(storage, now)[runId]?.token ?? null
}

export function dropRunToken(
  runId: string,
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): void {
  const entries = read(storage, now)
  if (!(runId in entries)) {
    // Still rewrite: `read` pruned expired entries.
    write(storage, entries)
    return
  }
  delete entries[runId]
  write(storage, entries)
}
