import "client-only"

/**
 * Pure core of `useSync`'s store subscriber: given the previous diff
 * baseline and the next store snapshot, produce the SyncOps to enqueue.
 *
 * Split out of `lib/client/hooks/use-sync.ts` so the held-message logic
 * (defer per-token message diffs while a conversation streams, then
 * diff once from the pre-stream baseline when the stream settles) is
 * unit-testable without React or the store.
 */

import {
  diffArtifacts,
  diffConversationMessages,
  diffConversations,
  diffConversationFiles,
  diffConversationMcpResources,
  diffConversationUrlBookmarks,
  diffDocuments,
  diffFiles,
  diffMcpResourceBindings,
  diffMcpResources,
  diffMcpServers,
  diffNotes,
  diffProjectTasks,
  diffPrompts,
  diffResources,
  diffUrlBookmarks,
  diffWorkspaces,
} from "@/client/sync/handlers"
import type { SyncOp } from "@/client/sync/sync-queue"
import type {
  Artifact,
  Conversation,
  ConversationFile,
  ConversationMcpResource,
  ConversationUrlBookmark,
  Document,
  McpResource,
  McpResourceBinding,
  McpServer,
  Message,
  Note,
  ProjectTask,
  Prompt,
  Resource,
  UploadedFile,
  UrlBookmark,
  Workspace,
} from "@/shared/types"

export interface SyncSnapshot {
  workspaces: Workspace[]
  documents: Document[]
  conversations: Conversation[]
  files: UploadedFile[]
  resources: Resource[]
  conversationFiles: ConversationFile[]
  notes: Note[]
  artifacts: Artifact[]
  prompts: Prompt[]
  projectTasks: ProjectTask[]
  mcpServers: McpServer[]
  mcpResources: McpResource[]
  mcpResourceBindings: McpResourceBinding[]
  conversationMcpResources: ConversationMcpResource[]
  urlBookmarks: UrlBookmark[]
  conversationUrlBookmarks: ConversationUrlBookmark[]
}

/**
 * Ops for rows that reference a held (mid-stream, not yet uploaded)
 * message, keyed by the held conversation id. Kept in production order;
 * released — collapsed to the last op per row — right after that
 * conversation's message upserts.
 */
export type DeferredDependentOps = Map<string, SyncOp[]>

/** Targets whose rows carry a `message_id` FK to `messages` (plus the
 *  0031 ownership check on it): an upsert that reaches the cloud before
 *  its message fails (23503 / 42501) and is dropped, then the next pull
 *  deletes the local row — and its IndexedDB bytes with it. */
const MESSAGE_DEPENDENT_TARGETS: ReadonlySet<SyncOp["target"]> = new Set([
  "artifacts",
  "notes",
])

function rowKey(op: SyncOp): string | null {
  if (!MESSAGE_DEPENDENT_TARGETS.has(op.target)) return null
  if (op.kind === "upsert") {
    const id = op.row.id
    return typeof id === "string" ? `${op.target}:${id}` : null
  }
  if (op.kind === "delete" && op.where.column === "id") {
    return `${op.target}:${op.where.value}`
  }
  return null
}

/** Last op per row, in the order those last ops were produced. */
function collapseByRow(ops: readonly SyncOp[]): SyncOp[] {
  const lastIndex = new Map<string, number>()
  ops.forEach((op, i) => lastIndex.set(rowKey(op) ?? `#${i}`, i))
  return ops.filter((op, i) => lastIndex.get(rowKey(op) ?? `#${i}`) === i)
}

/** Every parked op, in production order. The pause baseline marks their
 *  rows dirty: the diff baseline has them, the cloud does not. */
export function allDeferredOps(deferred: DeferredDependentOps): SyncOp[] {
  return [...deferred.values()].flat()
}

/**
 * Pure core of the per-change diff. Given the previous baseline, the
 * next snapshot, the currently-held conversation ids and the held
 * baselines map (mutated in place: new holds recorded, released holds
 * removed), returns the ops to enqueue.
 *
 * `deferred` (mutated in place) parks artifact / note ops whose row
 * references a message of a held conversation that is not in that
 * conversation's pre-stream baseline — a message the cloud doesn't have
 * yet (the streaming placeholder). Later ops on a parked row are parked
 * behind it so a delete can't overtake the upsert. When the hold is
 * released the parked ops are emitted right AFTER the message upserts,
 * collapsed to the last op per row; a reference to a message that no
 * longer exists (removed mid-stream) is sent as null, mirroring the
 * FK's `on delete set null`.
 */
export function computeSyncOps(
  prev: SyncSnapshot,
  next: SyncSnapshot,
  held: ReadonlySet<string>,
  baselines: Map<string, Message[]>,
  deferred: DeferredDependentOps = new Map()
): SyncOp[] {
  // Record the baseline for any newly-held conversation *before* the
  // change in `next` is folded in.
  for (const id of held) {
    if (!baselines.has(id)) {
      baselines.set(
        id,
        prev.conversations.find((c) => c.id === id)?.messages ?? []
      )
    }
  }

  // Release holds that just ended: one diff from the pre-stream
  // baseline to the final message state.
  const released = new Set<string>()
  const releaseOps: SyncOp[] = []
  for (const [id, baseline] of baselines) {
    if (held.has(id)) continue
    baselines.delete(id)
    released.add(id)
    const conv = next.conversations.find((c) => c.id === id)
    // Deleted mid-stream → the conversations diff below emits the
    // delete (Postgres cascades the messages).
    if (conv) releaseOps.push(...diffConversationMessages(id, baseline, conv.messages))
  }

  // Parked ops of a conversation whose hold ended without a baseline
  // entry (e.g. rebased away by a pull) must still go out.
  for (const id of deferred.keys()) {
    if (!held.has(id)) released.add(id)
  }
  const hasReleasedDeferred = [...released].some((id) => deferred.has(id))

  if (
    releaseOps.length === 0 &&
    !hasReleasedDeferred &&
    prev.workspaces === next.workspaces &&
    prev.documents === next.documents &&
    prev.conversations === next.conversations &&
    prev.files === next.files &&
    prev.resources === next.resources &&
    prev.conversationFiles === next.conversationFiles &&
    prev.notes === next.notes &&
    prev.artifacts === next.artifacts &&
    prev.prompts === next.prompts &&
    prev.projectTasks === next.projectTasks &&
    prev.mcpServers === next.mcpServers &&
    prev.mcpResources === next.mcpResources &&
    prev.mcpResourceBindings === next.mcpResourceBindings &&
    prev.conversationMcpResources === next.conversationMcpResources &&
    prev.urlBookmarks === next.urlBookmarks &&
    prev.conversationUrlBookmarks === next.conversationUrlBookmarks
  ) {
    return []
  }

  // Released conversations are skipped here too — their messages were
  // just diffed from the baseline above; diffing prev → next again
  // would double-enqueue.
  const skipMessageIds = new Set([...held, ...released])

  const entityOps: SyncOp[] = [
    ...(prev.workspaces !== next.workspaces
      ? diffWorkspaces(prev.workspaces, next.workspaces)
      : []),
    ...(prev.documents !== next.documents
      ? diffDocuments(prev.documents, next.documents)
      : []),
    ...(prev.conversations !== next.conversations
      ? diffConversations(prev.conversations, next.conversations, {
          streamingConversationIds: skipMessageIds,
        })
      : []),
    ...(prev.files !== next.files ? diffFiles(prev.files, next.files) : []),
    ...(prev.resources !== next.resources
      ? diffResources(prev.resources, next.resources)
      : []),
    ...(prev.conversationFiles !== next.conversationFiles
      ? diffConversationFiles(prev.conversationFiles, next.conversationFiles)
      : []),
    ...(prev.notes !== next.notes ? diffNotes(prev.notes, next.notes) : []),
    ...(prev.artifacts !== next.artifacts
      ? diffArtifacts(prev.artifacts, next.artifacts)
      : []),
    ...(prev.prompts !== next.prompts
      ? diffPrompts(prev.prompts, next.prompts)
      : []),
    ...(prev.projectTasks !== next.projectTasks
      ? diffProjectTasks(prev.projectTasks, next.projectTasks)
      : []),
    ...(prev.mcpServers !== next.mcpServers
      ? diffMcpServers(prev.mcpServers, next.mcpServers)
      : []),
    ...(prev.mcpResources !== next.mcpResources
      ? diffMcpResources(prev.mcpResources, next.mcpResources)
      : []),
    ...(prev.mcpResourceBindings !== next.mcpResourceBindings
      ? diffMcpResourceBindings(
          prev.mcpResourceBindings,
          next.mcpResourceBindings
        )
      : []),
    ...(prev.conversationMcpResources !== next.conversationMcpResources
      ? diffConversationMcpResources(
          prev.conversationMcpResources,
          next.conversationMcpResources
        )
      : []),
    ...(prev.urlBookmarks !== next.urlBookmarks
      ? diffUrlBookmarks(prev.urlBookmarks, next.urlBookmarks)
      : []),
    ...(prev.conversationUrlBookmarks !== next.conversationUrlBookmarks
      ? diffConversationUrlBookmarks(
          prev.conversationUrlBookmarks,
          next.conversationUrlBookmarks
        )
      : []),
  ]

  // Messages the cloud doesn't have yet: present in a held conversation,
  // absent from its pre-stream baseline.
  const heldNewMessage = new Map<string, string>() // message id → conv id
  for (const id of held) {
    const conv = next.conversations.find((c) => c.id === id)
    if (!conv) continue
    const before = new Set((baselines.get(id) ?? []).map((m) => m.id))
    for (const m of conv.messages) {
      if (!before.has(m.id)) heldNewMessage.set(m.id, id)
    }
  }
  const parkedRow = new Map<string, string>() // row key → conv id
  for (const [convId, ops] of deferred) {
    for (const op of ops) {
      const key = rowKey(op)
      if (key) parkedRow.set(key, convId)
    }
  }
  const passOps: SyncOp[] = []
  for (const op of entityOps) {
    const key = rowKey(op)
    const messageId =
      op.kind === "upsert" && typeof op.row.message_id === "string"
        ? op.row.message_id
        : null
    const convId =
      key === null
        ? undefined
        : (parkedRow.get(key) ??
          (messageId ? heldNewMessage.get(messageId) : undefined))
    if (key === null || convId === undefined) {
      passOps.push(op)
      continue
    }
    const list = deferred.get(convId) ?? []
    list.push(op)
    deferred.set(convId, list)
    parkedRow.set(key, convId)
  }

  const releasedDeferred: SyncOp[] = []
  for (const id of released) {
    const ops = deferred.get(id)
    if (!ops) continue
    deferred.delete(id)
    const live = new Set(
      next.conversations.find((c) => c.id === id)?.messages.map((m) => m.id) ??
        []
    )
    for (const op of collapseByRow(ops)) {
      const dangling =
        op.kind === "upsert" &&
        typeof op.row.message_id === "string" &&
        !live.has(op.row.message_id)
      releasedDeferred.push(
        dangling && op.kind === "upsert"
          ? { ...op, row: { ...op.row, message_id: null } }
          : op
      )
    }
  }

  return [...releaseOps, ...releasedDeferred, ...passOps]
}

