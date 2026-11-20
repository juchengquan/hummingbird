"use client"
import "client-only"

/**
 * Background sync queue. Mirrors local Zustand mutations to Supabase when
 * the user is signed in and online.
 *
 * Design notes:
 * - The queue is process-local but persisted to `localStorage` under
 *   `hummingbird-sync-queue`, so pending writes survive reloads.
 * - It pauses entirely when the user is signed out, Supabase isn't
 *   configured, or the browser is offline. The producer side keeps
 *   enqueueing — replay happens once the gate opens.
 * - Per-op exponential backoff caps at 60s. Permanent failures (4xx that
 *   aren't 401/408/429) are dropped so a malformed op can't wedge the queue.
 * - Ops are tagged with `clientOpId` (a UUID assigned at enqueue) for
 *   logging. The DB row PK is whatever the handler picks (typically the
 *   entity id from the Zustand store).
 * - Ops are stamped with `ownerUserId` (the signed-in user at enqueue).
 *   The flush only replays ops owned by the CURRENT user and drops the
 *   rest, so on a shared machine user A's unflushed edits can never be
 *   written into user B's account. See `pruneForeignOps`.
 */

import type { AppSupabaseClient } from "@/client/supabase/client"
import { uuid } from "@/shared/uuid"
import { getLocalDataOwner } from "@/client/sync/sync-owner"

const STORAGE_KEY = "hummingbird-sync-queue"
const MAX_BACKOFF_MS = 60_000
const BASE_BACKOFF_MS = 500

/** Type of cloud mutation. The handler is determined by `op.target`. */
export type SyncOp =
  | {
      kind: "upsert"
      target: SyncTarget
      clientOpId: string
      /** Row to send to .upsert(). user_id MUST be present. */
      row: Record<string, unknown>
      attempts?: number
      /** User id that produced this op (see header). Absent only on ops
       *  persisted by builds that predate owner stamping. */
      ownerUserId?: string
    }
  | {
      kind: "delete"
      target: SyncTarget
      clientOpId: string
      /** Row identifier. Most tables key on `id`. */
      where: { column: string; value: string }
      attempts?: number
      /** User id that produced this op (see header). Absent only on ops
       *  persisted by builds that predate owner stamping. */
      ownerUserId?: string
    }
  | {
      kind: "deleteMany"
      target: SyncTarget
      clientOpId: string
      /** Used for cascades where Postgres's ON DELETE doesn't quite match. */
      filters: Array<{ column: string; value: string | string[] }>
      attempts?: number
      /** User id that produced this op (see header). Absent only on ops
       *  persisted by builds that predate owner stamping. */
      ownerUserId?: string
    }

export type SyncTarget =
  | "workspaces"
  | "documents"
  | "conversations"
  | "messages"
  | "files"
  | "resources"
  | "conversation_files"
  | "artifacts"
  | "notes"
  | "mcp_servers"
  | "mcp_resources"
  | "mcp_resource_bindings"
  | "conversation_mcp_resources"
  | "url_bookmarks"
  | "conversation_url_bookmarks"
  | "prompts"
  | "project_tasks"

/** A SyncOp before the queue assigns its `clientOpId` (distributes over
 *  the union so each variant keeps its own fields). */
type WithoutClientOpId<T> = T extends unknown
  ? Omit<T, "clientOpId"> & { clientOpId?: string }
  : never
export type NewSyncOp = WithoutClientOpId<SyncOp>

interface QueueState {
  ops: SyncOp[]
  /** Wall-clock ms timestamp at which the next attempt is allowed. */
  notBefore: number
}

// In-memory state. Persists to localStorage on every change.
let state: QueueState = { ops: [], notBefore: 0 }

/**
 * Ops that flushed successfully, newest last, tagged with a monotonic
 * sequence number. In-memory only (bounded). Lets a cloud pull that was
 * fetched BEFORE an op flushed still treat that op as "local is ahead"
 * — otherwise a delete that lands while the snapshot request is in
 * flight would be resurrected by the (now stale) snapshot.
 */
const FLUSHED_JOURNAL_CAP = 500
let flushSeq = 0
let flushedJournal: Array<{ seq: number; op: SyncOp }> = []
let flushing = false
let scheduled: ReturnType<typeof setTimeout> | null = null

let client: AppSupabaseClient | null = null
let userId: string | null = null
// `!== false`: runtimes without `navigator.onLine` (bun test) count as online.
let online = typeof navigator !== "undefined" ? navigator.onLine !== false : true
let initialized = false

// -- persistence -------------------------------------------------------------

function load(): void {
  if (typeof window === "undefined") return
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<QueueState>
    if (Array.isArray(parsed.ops)) {
      state.ops = attributeLegacyOps(parsed.ops as SyncOp[], getLocalDataOwner())
    }
    if (typeof parsed.notBefore === "number") state.notBefore = parsed.notBefore
  } catch {
    // Corrupt queue — discard rather than blocking forever.
    state = { ops: [], notBefore: 0 }
  }
}

/**
 * Ops persisted before owner stamping carry no `ownerUserId`. Attribute
 * them to the device's known local-data owner when that is unambiguous
 * (an explicit owner record, or exactly one account ever reconciled
 * here — ops are only produced while signed in, so they can only be
 * that account's). Otherwise leave them unowned: `pruneForeignOps`
 * drops unowned ops, because replaying a write under the wrong account
 * (a cross-account data leak) is worse than losing an unflushed edit
 * that is still present in the local store.
 *
 * Exported for tests.
 */
export function attributeLegacyOps(
  ops: SyncOp[],
  legacyOwner: string | null
): SyncOp[] {
  if (!legacyOwner) return ops
  return ops.map((op) =>
    op.ownerUserId ? op : ({ ...op, ownerUserId: legacyOwner } as SyncOp)
  )
}

/**
 * Drops every queued op that doesn't belong to the current user
 * (including unowned legacy ops). No-op while signed out — ops wait for
 * their owner (or get cleared by sign-out).
 */
function pruneForeignOps(): void {
  if (!userId) return
  const before = state.ops.length
  const kept = state.ops.filter((op) => op.ownerUserId === userId)
  if (kept.length === before) return
  console.warn(
    `[sync] dropping ${before - kept.length} queued op(s) that belong to another account`
  )
  state.ops = kept
  state.notBefore = 0
  persist()
}

function persist(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage full / disabled — accept that pending ops won't survive
    // a reload. Don't crash.
  }
}

// -- gating ------------------------------------------------------------------

function gateOpen(): boolean {
  return !!client && !!userId && online && state.ops.length > 0
}

function scheduleFlush(delayMs = 0): void {
  if (scheduled !== null) {
    clearTimeout(scheduled)
    scheduled = null
  }
  if (!gateOpen()) return
  const wait = Math.max(delayMs, state.notBefore - Date.now(), 0)
  scheduled = setTimeout(() => {
    scheduled = null
    void flush()
  }, wait)
}

// -- flush loop --------------------------------------------------------------

async function flush(): Promise<void> {
  if (flushing) return
  if (!gateOpen()) return
  flushing = true
  try {
    while (state.ops.length > 0 && gateOpen()) {
      pruneForeignOps()
      if (state.ops.length === 0) break
      const op = state.ops[0]
      const result = await runOp(op)
      // The queue may have been reset (sign-out) or pruned (user switch)
      // while the request was in flight. Only settle the op we ran, and
      // only if it's still at the head; otherwise re-evaluate.
      if (state.ops[0] !== op) continue
      if (result === "ok") {
        state.ops.shift()
        state.notBefore = 0
        recordFlushed(op)
        persist()
        continue
      }
      if (result === "drop") {
        // 4xx that won't be fixed by retrying. Surface to console; don't
        // wedge the queue.
        console.warn("[sync] dropping un-retryable op", op)
        state.ops.shift()
        state.notBefore = 0
        persist()
        continue
      }
      // retry
      const attempts = (op.attempts ?? 0) + 1
      const next: SyncOp = { ...op, attempts } as SyncOp
      state.ops[0] = next
      const backoff = Math.min(
        BASE_BACKOFF_MS * 2 ** (attempts - 1),
        MAX_BACKOFF_MS
      )
      state.notBefore = Date.now() + backoff
      persist()
      // Reschedule and bail; we'll come back when notBefore passes.
      scheduleFlush(backoff)
      return
    }
  } finally {
    flushing = false
  }
}

type OpResult = "ok" | "retry" | "drop"

function recordFlushed(op: SyncOp): void {
  flushSeq += 1
  flushedJournal.push({ seq: flushSeq, op })
  if (flushedJournal.length > FLUSHED_JOURNAL_CAP) {
    flushedJournal = flushedJournal.slice(-FLUSHED_JOURNAL_CAP)
  }
}

async function runOp(op: SyncOp): Promise<OpResult> {
  if (!client || !userId) return "retry"
  // Belt-and-braces: never write another account's op under this session.
  if (op.ownerUserId !== userId) return "drop"
  try {
    if (op.kind === "upsert") {
      const row = { ...op.row, user_id: userId }
      const { error } = await client
        .from(op.target)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .upsert(row as any, { onConflict: "id" })
      if (error) return classify(error.code)
      return "ok"
    }
    if (op.kind === "delete") {
      const { error } = await client
        .from(op.target)
        .delete()
        .eq(op.where.column, op.where.value)
      if (error) return classify(error.code)
      return "ok"
    }
    if (op.kind === "deleteMany") {
      let q = client.from(op.target).delete()
      for (const f of op.filters) {
        q = Array.isArray(f.value) ? q.in(f.column, f.value) : q.eq(f.column, f.value)
      }
      const { error } = await q
      if (error) return classify(error.code)
      return "ok"
    }
  } catch (err) {
    // Network or unexpected — retry.
    console.warn("[sync] op threw", err)
    return "retry"
  }
  return "retry"
}

function classify(code: string | undefined): OpResult {
  // PostgrestError.code is a Postgres SQLSTATE for backend errors, or an
  // empty string for transport errors. Heuristics:
  //  - 23xxx integrity_constraint_violation → drop (malformed write)
  //  - 22xxx data_exception → drop
  //  - 42xxx syntax / undefined object → drop (programmer error)
  //  - 4xx string codes from postgrest (PGRST200 etc.) starting with PGRST
  //    fall through to drop too.
  //  - Anything else / empty → assume transient, retry.
  if (!code) return "retry"
  if (code.startsWith("23")) return "drop"
  if (code.startsWith("22")) return "drop"
  if (code.startsWith("42")) return "drop"
  if (code.startsWith("PGRST")) return "drop"
  return "retry"
}

// -- public API --------------------------------------------------------------

export function ensureInit(): void {
  if (initialized) return
  initialized = true
  if (typeof window === "undefined") return
  load()
  window.addEventListener("online", () => {
    online = true
    scheduleFlush()
  })
  window.addEventListener("offline", () => {
    online = false
  })
}

export function configureSync(opts: {
  client: AppSupabaseClient | null
  userId: string | null
}): void {
  ensureInit()
  client = opts.client
  userId = opts.userId
  pruneForeignOps()
  if (gateOpen()) scheduleFlush()
}

/**
 * Appends an op. `ownerUserId` defaults to the user the queue is
 * currently configured for (producers only enqueue while signed in).
 */
export function enqueue(op: NewSyncOp): void {
  ensureInit()
  const clientOpId = op.clientOpId ?? cryptoRandomId()
  const ownerUserId = op.ownerUserId ?? userId ?? undefined
  state.ops.push({ ...op, clientOpId, ownerUserId } as SyncOp)
  persist()
  scheduleFlush()
}

export function pendingOpCount(): number {
  return state.ops.length
}

/**
 * Opaque marker for `pendingOpsFor(..., { since })`. Take it right
 * before fetching a cloud snapshot.
 */
export function syncQueueMark(): number {
  return flushSeq
}

/**
 * Ops owned by `ownerUserId` whose effect the cloud may not reflect yet:
 * everything still queued, plus (when `since` is given) ops that flushed
 * after that mark — a snapshot fetched before them is stale for those
 * rows. Queue order is preserved (flushed ops first, they're older).
 */
export function pendingOpsFor(
  ownerUserId: string,
  opts: { since?: number } = {}
): SyncOp[] {
  ensureInit()
  const flushed =
    opts.since === undefined
      ? []
      : flushedJournal.filter((e) => e.seq > opts.since!).map((e) => e.op)
  return [...flushed, ...state.ops].filter((op) => op.ownerUserId === ownerUserId)
}

/**
 * Resolves when the queue is empty (all ops succeeded or were dropped).
 * Resolves anyway after `timeoutMs` so callers can never wedge waiting
 * on a queue that can't make progress (e.g. permanently offline).
 *
 * Cloud-pull uses this so we never overwrite local-only edits with stale
 * cloud state.
 */
export function whenDrained(timeoutMs = 30_000): Promise<void> {
  if (state.ops.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (state.ops.length === 0 || Date.now() - t0 > timeoutMs) {
        resolve()
        return
      }
      setTimeout(tick, 200)
    }
    tick()
  })
}

/** Sign-out / tests / hard resets. Drops every pending op. */
export function resetSyncQueue(): void {
  if (scheduled !== null) {
    clearTimeout(scheduled)
    scheduled = null
  }
  state = { ops: [], notBefore: 0 }
  flushedJournal = []
  persist()
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return uuid()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
