"use client"
import "client-only"

/**
 * Pure merge of a freshly-fetched cloud snapshot onto the current local
 * snapshot. Used by `applyCloudSnapshot` (reconcile.ts) so a cloud pull
 * no longer replaces local state wholesale.
 *
 * Rules, per entity id:
 *  1. Pending DELETE op for the id (still queued, or flushed after the
 *     snapshot was fetched) → drop the cloud row. Otherwise a pull that
 *     runs before the delete reaches Supabase resurrects the row.
 *  2. Pending UPSERT op and the entity exists locally → keep the local
 *     version (local is ahead; the queued op will push it). An entity
 *     that only exists locally with a pending upsert (created but not
 *     yet flushed) is kept too.
 *  3. Otherwise → the cloud version wins for every synced field, and
 *     the LOCAL-ONLY fields (no DB column; never pushed, never pulled)
 *     are copied over from the local entity with the same id.
 *
 * Messages are merged with the same rules inside each conversation.
 */

import type { Artifact, Conversation, Message, Workspace } from "@/shared/types"
import type { CloudSnapshot } from "@/client/sync/reconcile"
import type { SyncOp, SyncTarget } from "@/client/sync/sync-queue"
import { isMessageBlobRef, type BlobBearingItem } from "@/shared/message-blob-ref"

// ---------------------------------------------------------------------------
// Field classification.
//
// Every key of Workspace / Conversation / Message is either SYNCED (has a
// Supabase column, written by `handlers.ts` + `bulkUploadLocalState` and
// read back by `fetchCloudSnapshot`) or LOCAL-ONLY (lives only in the
// persisted Zustand store). The `Exhaustive` assertions below make
// `bun run typecheck` fail when a new key is added to one of these types
// without being classified here — if you add a field:
//   - with a DB column → add it to the *_SYNCED_KEYS list (and to the
//     row mappers in handlers.ts / reconcile.ts);
//   - without one → add it to the *_LOCAL_ONLY_KEYS list so a cloud pull
//     preserves it instead of silently dropping it.
// `snapshot-merge.test.ts` additionally round-trips the synced keys
// through the real upload/fetch mappers to keep the lists honest.
// ---------------------------------------------------------------------------

export const WORKSPACE_SYNCED_KEYS = [
  "id",
  "name",
  "createdAt",
  "updatedAt",
  "systemPrompt",
  "defaultModel",
  "skillPrefs",
  "isProject",
  "goal",
  "milestones",
  "position",
  "canvasState",
] as const satisfies readonly (keyof Workspace)[]

export const WORKSPACE_LOCAL_ONLY_KEYS = [
  "webSearchConfig",
  "webFetchConfig",
  "imageGenConfig",
  "fileSearchConfig",
] as const satisfies readonly (keyof Workspace)[]

export const CONVERSATION_SYNCED_KEYS = [
  "id",
  "workspaceId",
  "title",
  "messages",
  "createdAt",
  "updatedAt",
  "pinned",
  "systemPrompt",
  "selectedFileIds",
  "fileRetrievalModes",
  "selectedMcpResourceIds",
  "selectedUrlBookmarkIds",
  "skillPrefs",
  "parentId",
  "forkedFromMessageId",
] as const satisfies readonly (keyof Conversation)[]

export const CONVERSATION_LOCAL_ONLY_KEYS = [
  // Privacy opt-out from memory extraction — losing it on a pull would
  // silently resume extraction on a chat the user opted out of.
  "memoryOff",
  "selectedArtifactIds",
  "webSearchConfig",
  "webFetchConfig",
  "imageGenConfig",
  "fileSearchConfig",
] as const satisfies readonly (keyof Conversation)[]

export const MESSAGE_SYNCED_KEYS = [
  "id",
  "role",
  "content",
  "timestamp",
  "error",
  "reasoning",
  "reasoningDurationMs",
  "toolCalls",
  "attachedFileIds",
  "suggestions",
  "generatedImages",
  "generatedFiles",
  "compressed",
  "kind",
  "recapMessageIds",
  "turnPersona",
] as const satisfies readonly (keyof Message)[]

/** Synced, but written once, so the local value is as good as the cloud's
 *  and must survive a cloud row without it (a database before 0044, a row
 *  an older client wrote): losing `turnPersona` lifts an MCP restriction. */
const MESSAGE_WRITE_ONCE_KEYS = ["turnPersona"] as const satisfies readonly (keyof Message)[]

export const MESSAGE_LOCAL_ONLY_KEYS = [
  "verification",
  "codeResults",
  "uiParts",
  "routedModel",
  "mcpApps",
  "taskTurn",
] as const satisfies readonly (keyof Message)[]

/** Resolves to `true` only when `Keys` covers every key of `T`. */
type Exhaustive<T, Keys extends PropertyKey> = [Exclude<keyof T, Keys>] extends [never]
  ? true
  : { unclassified: Exclude<keyof T, Keys> }

// A type error on one of these lines names the unclassified key(s).
const workspaceKeysClassified: Exhaustive<
  Workspace,
  (typeof WORKSPACE_SYNCED_KEYS)[number] | (typeof WORKSPACE_LOCAL_ONLY_KEYS)[number]
> = true
const conversationKeysClassified: Exhaustive<
  Conversation,
  (typeof CONVERSATION_SYNCED_KEYS)[number] | (typeof CONVERSATION_LOCAL_ONLY_KEYS)[number]
> = true
const messageKeysClassified: Exhaustive<
  Message,
  (typeof MESSAGE_SYNCED_KEYS)[number] | (typeof MESSAGE_LOCAL_ONLY_KEYS)[number]
> = true
void workspaceKeysClassified
void conversationKeysClassified
void messageKeysClassified

/** Copies `keys` that are set on `local` onto a shallow copy of `cloud`. */
function withLocalOnly<T extends object>(
  cloud: T,
  local: T | undefined,
  keys: readonly (keyof T)[]
): T {
  if (!local) return cloud
  let out: T | null = null
  for (const k of keys) {
    if (local[k] === undefined) continue
    out ??= { ...cloud }
    out[k] = local[k]
  }
  return out ?? cloud
}

// ---------------------------------------------------------------------------
// Generated images / files (store v33 blob references)
// ---------------------------------------------------------------------------

/**
 * Per-item merge of one generated-item list when the cloud message wins.
 *
 *  - The cloud value is the source of truth for every item it carries: a
 *    real `data:` / signed URL from the cloud replaces a local
 *    `hb-blob:` reference (the offload re-stores it; nothing is lost if
 *    the local IndexedDB copy had gone missing).
 *  - A cloud item that is itself a reference (never written by this
 *    client — the queue resolves or omits — but defended against) keeps
 *    the LOCAL item's URL when the local side has one, so a placeholder
 *    from elsewhere can't overwrite real local bytes.
 *  - Items only the local side has are appended. Generated items are
 *    append-only (no UI removes one), so a cloud list lacking a local
 *    item is behind — e.g. its upsert omitted the column because a
 *    reference couldn't be resolved — never a deliberate removal.
 */
function mergeBlobItems<T extends BlobBearingItem>(
  cloud: T[] | undefined,
  local: T[] | undefined
): T[] | undefined {
  if (!local || local.length === 0) return cloud
  if (!cloud || cloud.length === 0) return local
  const localById = new Map(local.map((it) => [it.id, it]))
  let out: T[] | null = null
  cloud.forEach((item, i) => {
    if (!isMessageBlobRef(item.url)) return
    const mine = localById.get(item.id)
    if (!mine || mine.url === item.url) return
    out ??= cloud.slice()
    out[i] = { ...item, url: mine.url }
  })
  const cloudIds = new Set(cloud.map((it) => it.id))
  const extra = local.filter((it) => !cloudIds.has(it.id))
  if (extra.length > 0) out = [...(out ?? cloud), ...extra]
  return out ?? cloud
}

/**
 * Store v34: `storagePath` of an artifact when the cloud row wins.
 *
 *  - Cloud real bytes (`data:` / signed URL / Storage path) replace a
 *    local `hb-blob:` reference — unless `isSameBlob` vouches that the
 *    reference already holds exactly those bytes (then keeping it avoids
 *    churning the artifact back to inline).
 *  - A cloud value that is a reference (never written by this client —
 *    the queue resolves or omits — but defended against) or NULL (an
 *    insert whose `storage_path` was omitted because the reference
 *    couldn't be resolved at flush time) never replaces a local value:
 *    nothing in the UI clears `storagePath`, so a cloud null next to a
 *    local value means the cloud is behind, not a deliberate removal.
 */
function withLocalArtifactBlob(
  c: Artifact,
  l: Artifact | undefined,
  isSameBlob: MergeOptions["isSameBlob"]
): Artifact {
  const local = l?.storagePath
  if (!local || local === c.storagePath) return c
  const cloud = c.storagePath
  if (cloud === null || cloud === undefined || isMessageBlobRef(cloud)) {
    return { ...c, storagePath: local }
  }
  if (isMessageBlobRef(local) && isSameBlob?.(local, cloud)) {
    return { ...c, storagePath: local }
  }
  return c
}

function withLocalBlobItems(c: Message, l: Message | undefined): Message {
  if (!l) return c
  const images = mergeBlobItems(c.generatedImages, l.generatedImages)
  const files = mergeBlobItems(c.generatedFiles, l.generatedFiles)
  if (images === c.generatedImages && files === c.generatedFiles) return c
  return {
    ...c,
    ...(images !== undefined ? { generatedImages: images } : {}),
    ...(files !== undefined ? { generatedFiles: files } : {}),
  }
}

// ---------------------------------------------------------------------------
// Pending-op index
// ---------------------------------------------------------------------------

type PendingKind = "upsert" | "delete"

/** target → entity id → kind of the LAST pending op touching it. */
export type PendingIndex = Map<SyncTarget, Map<string, PendingKind>>

export function indexPendingOps(ops: readonly SyncOp[]): PendingIndex {
  const index: PendingIndex = new Map()
  const mark = (target: SyncTarget, id: unknown, kind: PendingKind) => {
    if (typeof id !== "string" || !id) return
    let byId = index.get(target)
    if (!byId) {
      byId = new Map()
      index.set(target, byId)
    }
    byId.set(id, kind)
  }
  for (const op of ops) {
    if (op.kind === "upsert") {
      mark(op.target, op.row.id, "upsert")
    } else if (op.kind === "delete") {
      if (op.where.column === "id") mark(op.target, op.where.value, "delete")
    } else {
      // deleteMany: only id filters identify rows; others are ignored
      // (no producer emits them today).
      for (const f of op.filters) {
        if (f.column !== "id") continue
        for (const id of Array.isArray(f.value) ? f.value : [f.value]) {
          mark(op.target, id, "delete")
        }
      }
    }
  }
  return index
}

// ---------------------------------------------------------------------------
// List merge
// ---------------------------------------------------------------------------

const NO_PENDING: ReadonlyMap<string, PendingKind> = new Map()

/**
 * Per-entity merge for an id present in the cloud snapshot. `local` is
 * the same-id local entity (if any); `localAhead` is true when a pending
 * upsert means the local version must win.
 */
type MergeOne<T> = (cloud: T, local: T | undefined, localAhead: boolean) => T

/** Default: local wins wholesale when ahead, else cloud as-is. */
function keepLocalWhenAhead<T>(cloud: T, local: T | undefined, localAhead: boolean): T {
  return localAhead && local ? local : cloud
}

/**
 * Merges one entity list. Order follows the cloud list; local entities
 * kept because of a pending upsert (not present in the cloud) are
 * inserted right after their nearest preceding local neighbour that made
 * it into the result (or at the front), which keeps message order sane.
 */
function mergeList<T extends { id: string }>(
  local: readonly T[],
  cloud: readonly T[],
  pending: ReadonlyMap<string, PendingKind>,
  mergeOne: MergeOne<T>
): T[] {
  const localById = new Map(local.map((e) => [e.id, e]))
  const out: T[] = []
  for (const c of cloud) {
    const p = pending.get(c.id)
    if (p === "delete") continue
    out.push(mergeOne(c, localById.get(c.id), p === "upsert"))
  }
  if (pending.size === 0) return out

  const cloudIds = new Set(cloud.map((e) => e.id))
  let anchor = -1 // index in `out` after which the next insert goes
  for (const l of local) {
    if (cloudIds.has(l.id)) {
      const idx = out.findIndex((e) => e.id === l.id)
      if (idx !== -1) anchor = idx
      continue
    }
    if (pending.get(l.id) !== "upsert") continue
    out.splice(anchor + 1, 0, l)
    anchor += 1
  }
  return out
}

export interface MergeOptions {
  /** Ops whose effect the cloud snapshot may not reflect yet. */
  pendingOps?: readonly SyncOp[]
  /** Copy local-only fields from same-id local entities (default true).
   *  Pass false when the local data belongs to a different account. */
  keepLocalOnlyFields?: boolean
  /** Conversations whose messages are mid-stream locally (message diffs
   *  are deferred until the stream ends, so they have no pending ops
   *  yet). Their local messages are kept as-is. */
  streamingConversationIds?: ReadonlySet<string>
  /** True when `ref` (an `hb-blob:` reference) is known to hold exactly
   *  `value` (a `data:` URL). Lets a local artifact keep its reference
   *  when the cloud sends the same bytes inline. Omitted → never. */
  isSameBlob?: (ref: string, value: string) => boolean
}

/**
 * Local artifacts / notes that reference a message of a streaming
 * conversation the cloud doesn't have yet are "local ahead": their
 * upserts are parked until that message uploads (`computeSyncOps`), so
 * they have no queued op — without this a mid-stream pull would delete
 * them (and their IndexedDB bytes with them). A pending delete wins.
 */
function markRowsOnHeldMessages(
  index: PendingIndex,
  local: CloudSnapshot,
  cloud: CloudSnapshot,
  streaming: ReadonlySet<string> | undefined
): void {
  if (!streaming || streaming.size === 0) return
  const unsynced = new Set<string>()
  for (const id of streaming) {
    const l = local.conversations.find((c) => c.id === id)
    if (!l) continue
    const inCloud = new Set(
      cloud.conversations.find((c) => c.id === id)?.messages.map((m) => m.id) ??
        []
    )
    for (const m of l.messages) if (!inCloud.has(m.id)) unsynced.add(m.id)
  }
  if (unsynced.size === 0) return
  const mark = (
    target: SyncTarget,
    rows: readonly { id: string; messageId: string | null }[]
  ) => {
    for (const r of rows) {
      if (!r.messageId || !unsynced.has(r.messageId)) continue
      let byId = index.get(target)
      if (!byId) {
        byId = new Map()
        index.set(target, byId)
      }
      if (!byId.has(r.id)) byId.set(r.id, "upsert")
    }
  }
  mark("artifacts", local.artifacts)
  mark("notes", local.notes)
}

export function mergeCloudSnapshot(
  local: CloudSnapshot,
  cloud: CloudSnapshot,
  opts: MergeOptions = {}
): CloudSnapshot {
  const index = indexPendingOps(opts.pendingOps ?? [])
  const keepLocal = opts.keepLocalOnlyFields ?? true
  const streaming = opts.streamingConversationIds
  markRowsOnHeldMessages(index, local, cloud, streaming)
  const pendingFor = (t: SyncTarget) => index.get(t) ?? NO_PENDING

  function list<T extends { id: string }>(
    target: SyncTarget,
    l: readonly T[],
    c: readonly T[],
    mergeOne: MergeOne<T> = keepLocalWhenAhead
  ): T[] {
    return mergeList(l, c, pendingFor(target), mergeOne)
  }

  const mergeMessage: MergeOne<Message> = (c, l, ahead) =>
    ahead && l
      ? l
      : keepLocal
        ? withLocalBlobItems(
            withLocalOnly(c, l, [...MESSAGE_LOCAL_ONLY_KEYS, ...MESSAGE_WRITE_ONCE_KEYS]),
            l
          )
        : c

  // Header and messages are merged independently: a pending header
  // upsert keeps the local header, but the messages still follow their
  // own per-message pending ops.
  const mergeConversation: MergeOne<Conversation> = (c, l, ahead) => {
    const header =
      ahead && l ? l : keepLocal ? withLocalOnly(c, l, CONVERSATION_LOCAL_ONLY_KEYS) : c
    const messages =
      l && streaming?.has(c.id)
        ? l.messages
        : mergeList(l?.messages ?? [], c.messages, pendingFor("messages"), mergeMessage)
    return { ...header, messages }
  }

  return {
    workspaces: list("workspaces", local.workspaces, cloud.workspaces, (c, l, ahead) =>
      ahead && l ? l : keepLocal ? withLocalOnly(c, l, WORKSPACE_LOCAL_ONLY_KEYS) : c
    ),
    documents: list("documents", local.documents, cloud.documents),
    conversations: list(
      "conversations",
      local.conversations,
      cloud.conversations,
      mergeConversation
    ),
    files: list("files", local.files, cloud.files),
    resources: list("resources", local.resources, cloud.resources),
    conversationFiles: list(
      "conversation_files",
      local.conversationFiles,
      cloud.conversationFiles
    ),
    notes: list("notes", local.notes, cloud.notes),
    artifacts: list("artifacts", local.artifacts, cloud.artifacts, (c, l, ahead) =>
      ahead && l ? l : keepLocal ? withLocalArtifactBlob(c, l, opts.isSameBlob) : c
    ),
    prompts: list("prompts", local.prompts, cloud.prompts),
    projectTasks: list("project_tasks", local.projectTasks, cloud.projectTasks),
    mcpServers: list("mcp_servers", local.mcpServers, cloud.mcpServers),
    mcpResources: list("mcp_resources", local.mcpResources, cloud.mcpResources),
    mcpResourceBindings: list(
      "mcp_resource_bindings",
      local.mcpResourceBindings,
      cloud.mcpResourceBindings
    ),
    conversationMcpResources: list(
      "conversation_mcp_resources",
      local.conversationMcpResources,
      cloud.conversationMcpResources
    ),
    urlBookmarks: list("url_bookmarks", local.urlBookmarks, cloud.urlBookmarks),
    conversationUrlBookmarks: list(
      "conversation_url_bookmarks",
      local.conversationUrlBookmarks,
      cloud.conversationUrlBookmarks
    ),
  }
}
