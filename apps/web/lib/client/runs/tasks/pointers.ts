import "client-only"

/**
 * `humm.tasks.<userId>` (Q68): what one browser keeps about one user's
 * tasks — the starts it sent and hasn't seen listed (`launching`), the
 * results it wrote (`delivered`, until the server's mark is seen) and the
 * notifications it showed (`notified`). Keyed by the signed-in user, so
 * another account on the same browser never replays them (survey bug 6).
 *
 * Every read parses what is stored now (another tab may have written
 * since), and every write is a read-modify-write of the whole record, so
 * two tabs' writes to different keys don't lose each other's. A value
 * that doesn't parse is treated as empty. Storage failures (private mode,
 * quota) are swallowed: the server stays the authority.
 */

import { tasksPointerKey, type LaunchingTask, type TasksPointers } from "./types"

/** The `Storage` subset used here (a seam for tests). */
export type PointerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

/** How long a `delivered` / `notified` mark is kept — long past the point
 *  where the server's mark (or the event) can come back. */
const MARK_TTL_MS = 30 * 24 * 3600_000
/** Bound on each map, oldest dropped first. */
const MAX_MARKS = 500
/** A launch that has been retried this long without the server listing it
 *  is given up (the retries are idempotent, so this is a backstop). */
export const LAUNCH_GIVE_UP_MS = 24 * 3600_000

export function emptyPointers(): TasksPointers {
  return { v: 1, launching: [], delivered: {}, notified: {} }
}

function defaultStorage(): PointerStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v
  return out
}

function isLaunching(value: unknown): value is LaunchingTask {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.research === "boolean" &&
    isRecord(value.body)
  )
}

export function parsePointers(raw: string | null): TasksPointers {
  if (!raw) return emptyPointers()
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.v !== 1) return emptyPointers()
    return {
      v: 1,
      launching: Array.isArray(value.launching) ? value.launching.filter(isLaunching) : [],
      delivered: stringMap(value.delivered),
      notified: stringMap(value.notified),
    }
  } catch {
    return emptyPointers()
  }
}

/** Drop marks older than the TTL and cap each map. */
function prune(marks: Record<string, string>, now: number): Record<string, string> {
  const kept = Object.entries(marks).filter(([, at]) => {
    const t = Date.parse(at)
    return Number.isFinite(t) && now - t < MARK_TTL_MS
  })
  kept.sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]))
  return Object.fromEntries(kept.slice(-MAX_MARKS))
}

export class TaskPointers {
  private readonly key: string
  private readonly storage: PointerStorage | null

  constructor(userId: string, storage: PointerStorage | null = defaultStorage()) {
    this.key = tasksPointerKey(userId)
    this.storage = storage
  }

  read(): TasksPointers {
    try {
      return parsePointers(this.storage?.getItem(this.key) ?? null)
    } catch {
      return emptyPointers()
    }
  }

  /** Read, change, write back — synchronously, so nothing else in this
   *  tab runs in between. */
  update(change: (p: TasksPointers) => TasksPointers): TasksPointers {
    const next = change(this.read())
    const now = Date.now()
    const pruned: TasksPointers = {
      ...next,
      delivered: prune(next.delivered, now),
      notified: prune(next.notified, now),
    }
    try {
      this.storage?.setItem(this.key, JSON.stringify(pruned))
    } catch {
      // Private mode / quota: the server's marks still hold.
    }
    return pruned
  }

  launching(): LaunchingTask[] {
    return this.read().launching
  }

  addLaunching(task: LaunchingTask): void {
    this.update((p) => ({
      ...p,
      launching: [...p.launching.filter((t) => t.runId !== task.runId), task],
    }))
  }

  removeLaunching(runId: string): void {
    this.update((p) => ({ ...p, launching: p.launching.filter((t) => t.runId !== runId) }))
  }

  deliveredAt(rootRunId: string): string | null {
    return this.read().delivered[rootRunId] ?? null
  }

  markDelivered(rootRunId: string, at = new Date().toISOString()): void {
    this.update((p) => ({ ...p, delivered: { ...p.delivered, [rootRunId]: at } }))
  }

  forgetDelivered(rootRunId: string): void {
    this.update((p) => {
      if (!(rootRunId in p.delivered)) return p
      const delivered = { ...p.delivered }
      delete delivered[rootRunId]
      return { ...p, delivered }
    })
  }

  isNotified(key: string): boolean {
    return key in this.read().notified
  }

  markNotified(key: string, at = new Date().toISOString()): void {
    this.update((p) => ({ ...p, notified: { ...p.notified, [key]: at } }))
  }
}
