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
 * Pure core of the per-change diff. Given the previous baseline, the
 * next snapshot, the currently-held conversation ids and the held
 * baselines map (mutated in place: new holds recorded, released holds
 * removed), returns the ops to enqueue.
 */
export function computeSyncOps(
  prev: SyncSnapshot,
  next: SyncSnapshot,
  held: ReadonlySet<string>,
  baselines: Map<string, Message[]>
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

  if (
    releaseOps.length === 0 &&
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

  return [
    ...releaseOps,
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
}

