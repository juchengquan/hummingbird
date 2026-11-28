import "client-only"

import { useStore } from "@/client/hooks/use-store"
import { isUuid } from "@/shared/runs/ids"
import { uuid } from "@/shared/uuid"

/**
 * Every workspace and conversation needs a uuid id to sync: the cloud
 * columns are uuid. A browser's first-run scaffolding used fixed ids
 * (`"default"`, `"demo-1"`), so its first upload after sign-in failed
 * (`22P02`) and its data never synced. Before syncing, such ids are
 * replaced, with every reference to them.
 *
 * The replacements are kept in localStorage, so tabs of one browser that
 * remap at the same time agree on them.
 */

const STORAGE_KEY = "humm.syncableIds"

/** Keys whose string value is a workspace or conversation id. */
const REFERENCE_KEYS = new Set([
  "workspaceId",
  "conversationId",
  "activeWorkspaceId",
  "activeConversationId",
  "parentId",
])

function savedReplacements(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function saveReplacements(map: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Private mode / quota: this tab still remaps consistently.
  }
}

/** `value` with every reference in `map` replaced (pure; shares untouched branches). */
export function remapReferences<T>(value: T, map: ReadonlyMap<string, string>, key?: string): T {
  if (typeof value === "string") {
    return (key !== undefined && REFERENCE_KEYS.has(key) && map.has(value) ? map.get(value) : value) as T
  }
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = remapReferences(item, map)
      changed ||= next !== item
      return next
    })
    return (changed ? out : value) as T
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    let out: Record<string, unknown> | null = null
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = remapReferences(v, map, k)
      if (next !== v) {
        out ??= { ...(value as Record<string, unknown>) }
        out[k] = next
      }
    }
    return (out ?? value) as T
  }
  return value
}

/** Replacements for the store's non-uuid workspace / conversation ids. */
export function replacementsFor(
  ids: readonly string[],
  saved: Record<string, string>,
  mint: () => string = uuid
): Map<string, string> {
  const map = new Map<string, string>()
  for (const id of ids) {
    if (isUuid(id)) continue
    map.set(id, saved[id] && isUuid(saved[id]) ? saved[id] : mint())
  }
  return map
}

/**
 * Give the store's workspaces and conversations uuid ids, updating every
 * reference. A no-op once they all have one. Call before reading the
 * store for an upload.
 */
export function ensureSyncableIds(): void {
  const state = useStore.getState()
  const ids = [...state.workspaces.map((w) => w.id), ...state.conversations.map((c) => c.id)]
  const saved = savedReplacements()
  const map = replacementsFor(ids, saved)
  if (map.size === 0) return
  saveReplacements({ ...saved, ...Object.fromEntries(map) })

  const withIds = <T extends { id: string }>(rows: T[]): T[] =>
    rows.map((row) => (map.has(row.id) ? { ...row, id: map.get(row.id)! } : row))
  const partial = Object.fromEntries(
    Object.entries(state).filter(([, v]) => typeof v !== "function")
  ) as Record<string, unknown>
  const next = remapReferences(partial, map) as typeof partial
  useStore.setState({
    ...next,
    workspaces: withIds(next.workspaces as typeof state.workspaces),
    conversations: withIds(next.conversations as typeof state.conversations),
  })
}
