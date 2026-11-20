import "client-only"

/**
 * "Upload what I did while sync was paused."
 *
 * While cloud sync is paused (the "Local-only" toggle) or the user is
 * signed out, `useSync`'s diff subscriber is detached, so local edits
 * produce no SyncOps. Without this module, resuming made the CURRENT
 * state the new diff baseline (the paused edits were never queued) and
 * the reconcile pull then replaced them with the cloud copy: chats
 * created while paused vanished and deleted ones came back.
 *
 * Instead, when the subscriber detaches we record a compact PAUSE
 * BASELINE — the cloud-acknowledged state at that moment — and when it
 * re-attaches for the same user we diff baseline → current, enqueue the
 * ops (local edits win; rows deleted while paused are deleted in the
 * cloud) and only then let the reconcile flow pull.
 *
 * Compact form: the baseline never stores rows, only, per sync target,
 * `id → hash of the row the upsert would send`. That is enough to tell
 * "created / changed" (hash missing or different → upsert the current
 * row) from "deleted" (id in baseline, absent now → delete by id), and
 * it only notices changes to fields that actually reach the cloud.
 * Messages are grouped by conversation so a deleted conversation's
 * messages are left to the Postgres cascade instead of costing one
 * delete request each.
 *
 * Storage: its own localStorage key (`PAUSE_BASELINE_KEY`), NOT a key
 * of the persisted Zustand store, whose shape + `STORE_VERSION` are a
 * frozen contract. One record per device, stamped with the user id: the
 * local data belongs to one account at a time (`sync-owner.ts`).
 *
 * Multi-tab (decision): the baseline is per DEVICE, not per tab. The
 * entity store is shared across tabs (`store/cross-tab-sync.ts`) and so
 * is `localOnlyMode`, so pausing / resuming in one tab does the same in
 * every tab a moment later. Each tab that detaches merges its view into
 * the single record (`mergePauseBaselines`: union, disagreements dirty).
 * The FIRST tab to re-attach claims it (read + remove in one synchronous
 * step) and uploads the whole device's paused edits from the shared
 * store; tabs re-attaching after it find nothing and just re-seed their
 * diff baseline. Two tabs claiming at the same instant both upload —
 * harmless, upserts and id-deletes are idempotent. Known gap: an edit
 * another tab made in the ~100 ms before its store write reached the
 * claiming tab arrives there as a suppressed merge and is not uploaded
 * until that row changes again.
 *
 * Everything above the storage section is pure (no store, no React).
 */

import { computeSyncOps, type SyncSnapshot } from "@/client/sync/compute-sync-ops"
import type { NewSyncOp, SyncOp, SyncTarget } from "@/client/sync/sync-queue"

export const PAUSE_BASELINE_KEY = "hummingbird-sync-pause-baseline"

/** Hash of a row whose cloud copy is unknown (an op that never flushed).
 *  Never equal to a real hash, so the resume diff always re-sends it. */
const DIRTY = ""

/** Message bucket for dirty message deletes whose conversation is
 *  unknown (a delete op carries only the message id). */
const ORPHAN_CONVERSATION = "*"

export interface PauseBaseline {
  v: 1
  userId: string
  capturedAt: number
  /** target → entity id → row hash. Every target except `messages`. */
  rows: Partial<Record<SyncTarget, Record<string, string>>>
  /** conversation id → message id → row hash. */
  messages: Record<string, Record<string, string>>
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** cyrb53 — fast, well-distributed 53-bit string hash. */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * Hash of an upsert row. `*_at` timestamps are normalised, because a
 * date that went through a reload can come back as a differently
 * formatted ISO string (`toISO` passes strings through untouched) and
 * must not read as a change.
 */
export function hashRow(row: Record<string, unknown>): string {
  const json = JSON.stringify(row, (key, value) => {
    if (typeof value === "string" && key.endsWith("_at")) {
      const t = Date.parse(value)
      if (!Number.isNaN(t)) return new Date(t).toISOString()
    }
    return value
  })
  return cyrb53(json ?? "")
}

// ---------------------------------------------------------------------------
// Building / merging
// ---------------------------------------------------------------------------

const EMPTY_SNAPSHOT: SyncSnapshot = {
  workspaces: [],
  documents: [],
  conversations: [],
  files: [],
  resources: [],
  conversationFiles: [],
  notes: [],
  artifacts: [],
  prompts: [],
  projectTasks: [],
  mcpServers: [],
  mcpResources: [],
  mcpResourceBindings: [],
  conversationMcpResources: [],
  urlBookmarks: [],
  conversationUrlBookmarks: [],
}

type UpsertOp = Extract<SyncOp, { kind: "upsert" }>

/** The upserts a from-scratch upload of `snapshot` would send, in the
 *  queue's usual FK-safe entity order. Held (streaming) conversations
 *  are deliberately NOT skipped: their messages count as edits too. */
function fullUpserts(snapshot: SyncSnapshot): UpsertOp[] {
  return computeSyncOps(EMPTY_SNAPSHOT, snapshot, new Set(), new Map()).filter(
    (op): op is UpsertOp => op.kind === "upsert"
  )
}

function rowId(row: Record<string, unknown>): string | null {
  return typeof row.id === "string" && row.id ? row.id : null
}

function setHash(
  b: PauseBaseline,
  target: SyncTarget,
  id: string,
  hash: string,
  conversationId?: string
): void {
  if (target === "messages") {
    const conv = conversationId || ORPHAN_CONVERSATION
    ;(b.messages[conv] ??= {})[id] = hash
    return
  }
  ;(b.rows[target] ??= {})[id] = hash
}

/**
 * Marks the rows touched by `ops` dirty: ops the queue dropped without
 * flushing (sign-out reset, another account's prune), so the cloud may
 * lack what the diff baseline says it has. A dirty row is re-sent on
 * resume if it still exists, and deleted if it doesn't.
 *
 * Ops still QUEUED at pause are not dirty: they stay queued (owner-
 * stamped; a paused queue neither flushes nor prunes) and flush first
 * on resume, so the baseline — which already includes their effect —
 * is right about them, and marking them would only double-send.
 */
function markDirty(b: PauseBaseline, ops: readonly SyncOp[]): void {
  for (const op of ops) {
    if (op.kind === "upsert") {
      const id = rowId(op.row)
      if (!id) continue
      const conv =
        typeof op.row.conversation_id === "string" ? op.row.conversation_id : undefined
      // A dirty message upsert may already sit in its real bucket under
      // a real hash — overwrite it there.
      setHash(b, op.target, id, DIRTY, conv)
    } else if (op.kind === "delete") {
      if (op.where.column !== "id") continue
      setHash(b, op.target, op.where.value, DIRTY)
    } else {
      for (const f of op.filters) {
        if (f.column !== "id") continue
        for (const id of Array.isArray(f.value) ? f.value : [f.value]) {
          setHash(b, op.target, id, DIRTY)
        }
      }
    }
  }
}

/**
 * Builds the pause baseline for `userId` from the diff baseline at the
 * moment sync paused (`snapshot`), marking `droppedOps` (ops the queue
 * dropped unflushed) dirty.
 */
export function buildPauseBaseline(input: {
  userId: string
  snapshot: SyncSnapshot
  droppedOps?: readonly SyncOp[]
  now?: number
}): PauseBaseline {
  const b: PauseBaseline = {
    v: 1,
    userId: input.userId,
    capturedAt: input.now ?? Date.now(),
    rows: {},
    messages: {},
  }
  for (const op of fullUpserts(input.snapshot)) {
    const id = rowId(op.row)
    if (!id) continue
    const conv =
      typeof op.row.conversation_id === "string" ? op.row.conversation_id : undefined
    setHash(b, op.target, id, hashRow(op.row), conv)
  }
  markDirty(b, (input.droppedOps ?? []).filter((op) => op.ownerUserId === input.userId))
  return b
}

/** Pure: `b` with the rows of its owner's ops in `ops` marked dirty
 *  (other owners' ops are ignored). Returns `b` itself when untouched. */
export function withDirtyOps(b: PauseBaseline, ops: readonly SyncOp[]): PauseBaseline {
  const mine = ops.filter((op) => op.ownerUserId === b.userId)
  if (mine.length === 0) return b
  const out: PauseBaseline = {
    ...b,
    rows: Object.fromEntries(
      Object.entries(b.rows).map(([t, m]) => [t, { ...m }])
    ) as PauseBaseline["rows"],
    messages: Object.fromEntries(
      Object.entries(b.messages).map(([c, m]) => [c, { ...m }])
    ),
  }
  markDirty(out, mine)
  return out
}

function mergeHashMaps(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = { ...(a ?? {}) }
  for (const [id, h] of Object.entries(b ?? {})) {
    out[id] = id in out && out[id] !== h ? DIRTY : h
  }
  return out
}

/**
 * Combines two baselines of the SAME user (several tabs pausing, or a
 * pause recorded on top of one that was never resumed). Union of ids;
 * an id the two disagree on is dirty. Conservative by construction:
 * the worst case is re-sending a row the cloud already has, never
 * skipping one it lacks. The earlier `capturedAt` is kept.
 */
export function mergePauseBaselines(a: PauseBaseline, b: PauseBaseline): PauseBaseline {
  const rows: PauseBaseline["rows"] = {}
  for (const t of new Set([
    ...Object.keys(a.rows),
    ...Object.keys(b.rows),
  ]) as Set<SyncTarget>) {
    rows[t] = mergeHashMaps(a.rows[t], b.rows[t])
  }
  const messages: PauseBaseline["messages"] = {}
  for (const c of new Set([...Object.keys(a.messages), ...Object.keys(b.messages)])) {
    messages[c] = mergeHashMaps(a.messages[c], b.messages[c])
  }
  return {
    v: 1,
    userId: a.userId,
    capturedAt: Math.min(a.capturedAt, b.capturedAt),
    rows,
    messages,
  }
}

// ---------------------------------------------------------------------------
// Resume diff
// ---------------------------------------------------------------------------

/**
 * Link / leaf tables with a composite UNIQUE key (or a per-user unique
 * slug). Their deletes go FIRST so a row re-created under a new id with
 * the same key (unlink + relink while paused) doesn't hit a 23505 and
 * get dropped as un-retryable. Deleting them cascades nothing that
 * still exists locally.
 */
const EARLY_DELETE_TARGETS: readonly SyncTarget[] = [
  "conversation_files",
  "conversation_mcp_resources",
  "conversation_url_bookmarks",
  "mcp_resource_bindings",
  "mcp_resources",
  "prompts",
]

/** Parent-before-child order (the order `computeSyncOps` emits). Late
 *  deletes run in REVERSE, after every upsert, so a child that moved
 *  to a new parent while paused is re-parented before the old parent's
 *  cascade could take it down. */
const TARGET_ORDER: readonly SyncTarget[] = [
  "workspaces",
  "documents",
  "conversations",
  "messages",
  "files",
  "resources",
  "conversation_files",
  "notes",
  "artifacts",
  "prompts",
  "project_tasks",
  "mcp_servers",
  "mcp_resources",
  "mcp_resource_bindings",
  "conversation_mcp_resources",
  "url_bookmarks",
  "conversation_url_bookmarks",
]

function deleteOp(target: SyncTarget, id: string): NewSyncOp {
  return { kind: "delete", target, where: { column: "id", value: id } }
}

/**
 * The ops that bring the cloud from `baseline` to `current`:
 *   1. deletes of unique-keyed link rows gone since the pause,
 *   2. upserts of every row created or changed since (FK order),
 *   3. remaining deletes, children before parents. Messages of a
 *      conversation that is itself deleted are left to the cascade.
 * Pure. Ops carry no `clientOpId` / owner — the caller stamps them.
 */
export function computeResumeOps(baseline: PauseBaseline, current: SyncSnapshot): NewSyncOp[] {
  const upserts: NewSyncOp[] = []
  const liveIds = new Map<SyncTarget, Set<string>>()
  const liveMessages = new Map<string, Set<string>>()
  const allLiveMessageIds = new Set<string>()

  for (const op of fullUpserts(current)) {
    const id = rowId(op.row)
    if (!id) continue
    let before: string | undefined
    if (op.target === "messages") {
      const conv = String(op.row.conversation_id ?? "")
      let set = liveMessages.get(conv)
      if (!set) liveMessages.set(conv, (set = new Set()))
      set.add(id)
      allLiveMessageIds.add(id)
      const inConv = baseline.messages[conv]?.[id]
      const orphan = baseline.messages[ORPHAN_CONVERSATION]?.[id]
      before = orphan === DIRTY ? DIRTY : (inConv ?? orphan)
    } else {
      let set = liveIds.get(op.target)
      if (!set) liveIds.set(op.target, (set = new Set()))
      set.add(id)
      before = baseline.rows[op.target]?.[id]
    }
    if (before === undefined || before === DIRTY || before !== hashRow(op.row)) {
      upserts.push({ kind: "upsert", target: op.target, row: op.row })
    }
  }

  const deletesByTarget = new Map<SyncTarget, NewSyncOp[]>()
  const pushDelete = (target: SyncTarget, id: string) => {
    let list = deletesByTarget.get(target)
    if (!list) deletesByTarget.set(target, (list = []))
    list.push(deleteOp(target, id))
  }
  for (const [target, hashes] of Object.entries(baseline.rows) as Array<
    [SyncTarget, Record<string, string>]
  >) {
    const live = liveIds.get(target)
    for (const id of Object.keys(hashes)) {
      if (!live?.has(id)) pushDelete(target, id)
    }
  }
  const liveConversations = liveIds.get("conversations")
  for (const [conv, hashes] of Object.entries(baseline.messages)) {
    if (conv === ORPHAN_CONVERSATION) {
      for (const id of Object.keys(hashes)) {
        if (!allLiveMessageIds.has(id)) pushDelete("messages", id)
      }
      continue
    }
    // Conversation gone → `on delete cascade` removes its messages.
    if (!liveConversations?.has(conv)) continue
    const live = liveMessages.get(conv)
    for (const id of Object.keys(hashes)) {
      if (!live?.has(id)) pushDelete("messages", id)
    }
  }

  const early = EARLY_DELETE_TARGETS.flatMap((t) => deletesByTarget.get(t) ?? [])
  const late = [...TARGET_ORDER]
    .reverse()
    .filter((t) => !EARLY_DELETE_TARGETS.includes(t))
    .flatMap((t) => deletesByTarget.get(t) ?? [])
  return [...early, ...upserts, ...late]
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface OwnershipContext {
  /** `getLocalDataOwner()` — whose cloud graph the local data mirrors. */
  localOwner: string | null
  /** `hasReconciled(userId)`. */
  reconciled: boolean
}

/**
 * Record a pause baseline for `userId`? Only when the local data is
 * known to be theirs and already reconciled with their cloud — before
 * that (first sign-in, reconcile prompt pending, another account's
 * leftovers) the reconcile flow, not a diff, decides what gets uploaded.
 */
export function shouldCapturePauseBaseline(userId: string, ctx: OwnershipContext): boolean {
  return ctx.reconciled && ctx.localOwner === userId
}

export type ResumeDecision =
  /** No baseline recorded. */
  | "none"
  /** Baseline is this user's and the local data is still theirs. */
  | "upload"
  /** Baseline belongs to another account: leave it for them (if they
   *  sign back in before anyone else reconciles over the data). */
  | "keep"
  /** Baseline is this user's but the local data no longer is (another
   *  account reconciled over it since) — it can never apply again. */
  | "discard"

export function decideResume(
  baseline: PauseBaseline | null,
  userId: string,
  ctx: OwnershipContext
): ResumeDecision {
  if (!baseline) return "none"
  if (baseline.userId !== userId) {
    // The local data moved on to another owner → stale for good.
    return ctx.localOwner !== null && ctx.localOwner !== baseline.userId ? "discard" : "keep"
  }
  return shouldCapturePauseBaseline(userId, ctx) ? "upload" : "discard"
}

// ---------------------------------------------------------------------------
// Storage (localStorage, with an in-memory fallback)
// ---------------------------------------------------------------------------

/**
 * Set only when a write to localStorage failed (quota / blocked), so a
 * resume without a reload still works. Never consulted while storage
 * holds a record — another tab may have claimed that one already.
 */
let memoryFallback: PauseBaseline | null = null

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function isHashMap(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).every((h) => typeof h === "string")
  )
}

/** Validates a parsed record; anything malformed reads as "none". */
export function parsePauseBaseline(raw: string | null): PauseBaseline | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<PauseBaseline>
    if (
      p?.v !== 1 ||
      typeof p.userId !== "string" ||
      !p.userId ||
      typeof p.capturedAt !== "number" ||
      !p.rows ||
      typeof p.rows !== "object" ||
      !p.messages ||
      typeof p.messages !== "object"
    ) {
      return null
    }
    if (!Object.values(p.rows).every(isHashMap)) return null
    if (!Object.values(p.messages).every(isHashMap)) return null
    return p as PauseBaseline
  } catch {
    return null
  }
}

export function readPauseBaseline(): PauseBaseline | null {
  const ls = storage()
  if (ls) {
    try {
      const stored = parsePauseBaseline(ls.getItem(PAUSE_BASELINE_KEY))
      if (stored) return stored
    } catch {
      // fall through to the in-memory copy
    }
  }
  return memoryFallback
}

/**
 * Records `next`, merging with an existing record of the same user
 * (another tab paused first, or an earlier pause never resumed). A
 * record of a different user is replaced: the caller only saves after
 * `shouldCapturePauseBaseline`, i.e. the local data is now `next`'s
 * user's, so the other record could never pass `decideResume` again.
 */
export function savePauseBaseline(next: PauseBaseline): void {
  const existing = readPauseBaseline()
  writePauseBaseline(
    existing && existing.userId === next.userId ? mergePauseBaselines(existing, next) : next
  )
}

function writePauseBaseline(b: PauseBaseline): void {
  const ls = storage()
  try {
    if (!ls) throw new Error("no localStorage")
    ls.setItem(PAUSE_BASELINE_KEY, JSON.stringify(b))
    memoryFallback = null
  } catch (err) {
    // Quota / blocked: keep it in memory so a resume in this page
    // session still uploads; a reload while paused loses it (and falls
    // back to the old pull-only behaviour).
    console.warn("[sync] could not persist the pause baseline", err)
    memoryFallback = b
  }
}

/**
 * The queue dropped `ops` without flushing them (see `sync-queue.ts`).
 * If a pause baseline is recorded for their owner, mark those rows
 * dirty so the resume re-sends them.
 */
export function markPauseBaselineDirty(ops: readonly SyncOp[]): void {
  const existing = readPauseBaseline()
  if (!existing) return
  const next = withDirtyOps(existing, ops)
  if (next !== existing) writePauseBaseline(next)
}

export function clearPauseBaseline(): void {
  memoryFallback = null
  try {
    storage()?.removeItem(PAUSE_BASELINE_KEY)
  } catch {
    // best-effort
  }
}

/**
 * Takes the baseline for `userId` if it should be uploaded, removing it
 * from storage in the same synchronous step so a second tab resuming a
 * moment later finds nothing (first tab to resume uploads; the others
 * just re-seed their diff baseline). Stale records are cleared.
 */
export function claimPauseBaseline(
  userId: string,
  ctx: OwnershipContext
): PauseBaseline | null {
  const baseline = readPauseBaseline()
  const decision = decideResume(baseline, userId, ctx)
  if (decision === "upload" || decision === "discard") clearPauseBaseline()
  return decision === "upload" ? baseline : null
}
