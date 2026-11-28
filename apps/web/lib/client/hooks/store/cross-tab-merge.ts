import "client-only"

/**
 * Pure three-way merge of the persisted store between browser tabs.
 *
 * Every tab persists the WHOLE partialized store under one localStorage
 * key, so without this a tab that never re-reads storage silently
 * erases whatever another tab wrote (last-writer-wins on the full
 * blob). When another tab writes, `cross-tab-sync.ts` calls this with:
 *
 *   - `base`   — the persisted state this tab last agreed with storage
 *                on (its last flushed write, or the result of the last
 *                merge). Entities in it are the LIVE objects, so "did
 *                this tab touch X since?" is a reference check (store
 *                updates are immutable).
 *   - `ours`   — this tab's current partialized state (live objects).
 *   - `theirs` — the state the other tab just wrote (JSON-parsed).
 *
 * Rules, per entity (arrays of `{ id }` rows) or per top-level key:
 *   - only one side changed it since `base`  → that side's version
 *   - both changed it (conflict)             → theirs (the newer write)
 *   - added on one side                      → kept
 *   - deleted on one side, untouched on the other → deleted
 *   - deleted on one side, edited on the other    → the edit wins
 *   - a conversation this tab is streaming into  → ours over their
 *     copy, so an in-flight assistant message is never dropped
 *     mid-stream; but their DELETE of it wins (the stream is aborted)
 *   - per-tab view state (`PER_TAB_KEYS`)        → always ours, so
 *     switching conversation in one tab doesn't yank the other
 *
 * Identical content keeps this tab's live object, so an unrelated
 * write from another tab doesn't re-render every row.
 */

type Plain = Record<string, unknown>
type Entity = { id: string } & Plain

/** Keys that describe what THIS tab is looking at, not shared data. */
export const PER_TAB_KEYS: ReadonlySet<string> = new Set([
  "activeView",
  "activeWorkspaceId",
  "activeConversationId",
  "activeDocumentId",
  "resourcesSidebarOpen",
  "resourcesSidebarTab",
  "tasksPanelOpen",
  "sidebarWidth",
  "resourcesSidebarWidth",
])

/** Per-tab selection keys that must point at an entity that still
 *  exists after the merge; otherwise fall back to the other tab's. */
const PER_TAB_REFS: ReadonlyArray<[key: string, collection: string]> = [
  ["activeWorkspaceId", "workspaces"],
  ["activeConversationId", "conversations"],
  ["activeDocumentId", "documents"],
]

export interface CrossTabMergeInput {
  base: Plain
  ours: Plain
  theirs: Plain
  /** Conversations this tab is typing / streaming into. */
  heldConversationIds: ReadonlySet<string>
}

export interface CrossTabMergeResult {
  /** The merged persisted state to install in this tab. */
  merged: Plain
  /** The next `base`: what storage now holds (theirs), with each
   *  entity swapped for the merged object wherever the merge adopted
   *  it, so the next merge's reference checks line up. */
  nextBase: Plain
  /** True when `merged` carries shared data that `theirs` lacks, i.e.
   *  this tab must write back so the other tab picks it up. */
  oursWon: boolean
}

const jsonCache = new WeakMap<object, string>()
function json(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const hit = jsonCache.get(value)
    if (hit !== undefined) return hit
    const s = JSON.stringify(value) ?? ""
    jsonCache.set(value, s)
    return s
  }
  return JSON.stringify(value) ?? ""
}
function same(a: unknown, b: unknown): boolean {
  return a === b || json(a) === json(b)
}

function isEntityArray(v: unknown): v is Entity[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        e !== null && typeof e === "object" && typeof (e as Plain).id === "string"
    )
  )
}

function mergeEntities(
  base: Entity[],
  ours: Entity[],
  theirs: Entity[],
  isHeld: (id: string) => boolean
): { merged: Entity[]; nextBase: Entity[]; oursWon: boolean } {
  const baseById = new Map(base.map((e) => [e.id, e]))
  const oursById = new Map(ours.map((e) => [e.id, e]))
  const theirsIds = new Set(theirs.map((e) => e.id))
  let oursWon = false
  const merged: Entity[] = []
  const nextBase: Entity[] = []

  for (const t of theirs) {
    const o = oursById.get(t.id)
    const b = baseById.get(t.id)
    if (o === undefined) {
      if (b !== undefined && same(t, b)) {
        // We deleted it; they didn't touch it → stays deleted.
        oursWon = true
        nextBase.push(t)
      } else {
        // They added it, or edited it after our delete (edit wins).
        merged.push(t)
        nextBase.push(t)
      }
      continue
    }
    let pick: Entity
    if (isHeld(t.id) || same(o, t)) pick = o
    else if (o === b) pick = t // untouched here
    else if (b !== undefined && same(t, b)) pick = o // only we changed it
    else pick = t // both changed (or both added): the newer write wins
    merged.push(pick)
    if (pick === o && !same(o, t)) {
      oursWon = true
      nextBase.push(t)
    } else {
      nextBase.push(pick)
    }
  }

  // Rows only this tab has: added here (keep), or deleted there.
  const additions = new Set<string>()
  for (const o of ours) {
    if (theirsIds.has(o.id)) continue
    const b = baseById.get(o.id)
    // In `base` but not in theirs: the other tab deleted it. Our edits
    // win over that delete ("edit wins") — except a held row's: those
    // are the in-flight stream's token updates, not a user edit, and
    // keeping the row resurrected a conversation the user deleted (minus
    // the images its delete cascade dropped). The streaming tab aborts
    // that stream when the row disappears (`useChatSend`).
    const keep =
      b === undefined || (!isHeld(o.id) && !(o === b || same(o, b)))
    if (keep) {
      additions.add(o.id)
      oursWon = true
    }
  }
  // Slot each kept row after its predecessor in our order (new rows are
  // usually prepended, so most land at the front).
  if (additions.size > 0) {
    let prevId: string | null = null
    for (const o of ours) {
      if (additions.has(o.id)) {
        const at =
          prevId === null ? 0 : merged.findIndex((e) => e.id === prevId) + 1
        merged.splice(at, 0, o)
      }
      if (additions.has(o.id) || merged.some((e) => e.id === o.id)) {
        prevId = o.id
      }
    }
  }
  return { merged, nextBase, oursWon }
}

export function mergeCrossTabState({
  base,
  ours,
  theirs,
  heldConversationIds,
}: CrossTabMergeInput): CrossTabMergeResult {
  const merged: Plain = {}
  const nextBase: Plain = {}
  let oursWon = false

  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)])
  for (const key of keys) {
    const o = ours[key]
    const t = theirs[key]
    const b = base[key]
    if (!(key in theirs)) {
      merged[key] = o
      continue
    }
    if (!(key in ours) || PER_TAB_KEYS.has(key)) {
      merged[key] = key in ours ? o : t
      nextBase[key] = t
      continue
    }
    if (isEntityArray(o) && isEntityArray(t)) {
      const isHeld =
        key === "conversations"
          ? (id: string) => heldConversationIds.has(id)
          : () => false
      const r = mergeEntities(isEntityArray(b) ? b : [], o, t, isHeld)
      merged[key] = r.merged
      nextBase[key] = r.nextBase
      if (r.oursWon) oursWon = true
      continue
    }
    let pick: unknown
    if (same(o, t)) pick = o
    else if (o === b) pick = t
    else if (b !== undefined && same(t, b)) pick = o
    else pick = t
    merged[key] = pick
    if (pick === o && !same(o, t)) {
      oursWon = true
      nextBase[key] = t
    } else {
      nextBase[key] = pick
    }
  }

  for (const [key, collection] of PER_TAB_REFS) {
    const id = merged[key]
    if (typeof id !== "string") continue
    const rows = merged[collection]
    if (!Array.isArray(rows) || rows.some((r: Plain) => r?.id === id)) continue
    const fallback = theirs[key]
    merged[key] =
      typeof fallback === "string" &&
      rows.some((r: Plain) => r?.id === fallback)
        ? fallback
        : null
  }

  return { merged, nextBase, oursWon }
}
