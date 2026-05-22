"use client"
import "client-only"

/**
 * Wires the sync queue into the Zustand store. Mount once near the root
 * of `/dashboard` (see `app/dashboard/page.tsx`).
 *
 * Mechanism: subscribe to the relevant store slices. On every change,
 * diff the previous snapshot against the current snapshot per entity and
 * enqueue the resulting SyncOps. The diff functions are pure
 * (`lib/sync/handlers.ts`); the queue handles retries / persistence.
 *
 * We deliberately don't touch `lib/hooks/use-store.ts`. This keeps the
 * sync layer reversible — comment out one hook in the dashboard and
 * everything still works locally.
 */

import { useEffect, useRef } from "react"
import { useStore } from "@/client/hooks/use-store"
import { useSyncEnabled } from "@/client/hooks/use-sync-enabled"
import { getSupabaseBrowserClient } from "@/client/supabase/client"
import { configureSync, enqueue } from "@/client/sync/sync-queue"
import {
  diffArtifacts,
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
  diffResources,
  diffUrlBookmarks,
  diffWorkspaces,
} from "@/client/sync/handlers"
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
  Note,
  Resource,
  UploadedFile,
  UrlBookmark,
  Workspace,
} from "@/shared/types"

interface Snapshot {
  workspaces: Workspace[]
  documents: Document[]
  conversations: Conversation[]
  files: UploadedFile[]
  resources: Resource[]
  conversationFiles: ConversationFile[]
  notes: Note[]
  artifacts: Artifact[]
  mcpServers: McpServer[]
  mcpResources: McpResource[]
  mcpResourceBindings: McpResourceBinding[]
  conversationMcpResources: ConversationMcpResource[]
  urlBookmarks: UrlBookmark[]
  conversationUrlBookmarks: ConversationUrlBookmark[]
}

// Module-level so the reconciliation flow can reset it after hydration.
let lastSnapshot: Snapshot | null = null

function takeSnapshot(): Snapshot {
  const s = useStore.getState()
  return {
    workspaces: s.workspaces,
    documents: s.documents,
    conversations: s.conversations,
    files: s.files,
    resources: s.resources,
    conversationFiles: s.conversationFiles,
    notes: s.notes,
    artifacts: s.artifacts,
    mcpServers: s.mcpServers,
    mcpResources: s.mcpResources,
    mcpResourceBindings: s.mcpResourceBindings,
    conversationMcpResources: s.conversationMcpResources,
    urlBookmarks: s.urlBookmarks,
    conversationUrlBookmarks: s.conversationUrlBookmarks,
  }
}

export function useSync(): void {
  // `useSyncEnabled` folds in the local-only opt-out so disabling cloud
  // sync via the toggle behaves identically to being signed out.
  const { enabled, userId } = useSyncEnabled()

  // Wire the queue's client+user.
  useEffect(() => {
    const client = getSupabaseBrowserClient()
    configureSync({
      client,
      userId: enabled ? userId : null,
    })
  }, [enabled, userId])

  // On sign-out / local-mode-toggled-on, clear the snapshot so a future
  // re-enable re-seeds cleanly.
  useEffect(() => {
    if (!enabled) {
      lastSnapshot = null
    }
  }, [enabled])

  // Subscribe to store changes and produce SyncOps. The first change
  // after enabling seeds the snapshot if reconciliation hasn't already.
  useEffect(() => {
    if (!enabled || !userId) return

    if (lastSnapshot === null) {
      lastSnapshot = takeSnapshot()
    }

    const unsubscribe = useStore.subscribe((state) => {
      const next: Snapshot = {
        workspaces: state.workspaces,
        documents: state.documents,
        conversations: state.conversations,
        files: state.files,
        resources: state.resources,
        conversationFiles: state.conversationFiles,
        notes: state.notes,
        artifacts: state.artifacts,
        mcpServers: state.mcpServers,
        mcpResources: state.mcpResources,
        mcpResourceBindings: state.mcpResourceBindings,
        conversationMcpResources: state.conversationMcpResources,
        urlBookmarks: state.urlBookmarks,
        conversationUrlBookmarks: state.conversationUrlBookmarks,
      }
      const prev = lastSnapshot
      if (!prev) {
        lastSnapshot = next
        return
      }

      if (
        prev.workspaces === next.workspaces &&
        prev.documents === next.documents &&
        prev.conversations === next.conversations &&
        prev.files === next.files &&
        prev.resources === next.resources &&
        prev.conversationFiles === next.conversationFiles &&
        prev.notes === next.notes &&
        prev.artifacts === next.artifacts &&
        prev.mcpServers === next.mcpServers &&
        prev.mcpResources === next.mcpResources &&
        prev.mcpResourceBindings === next.mcpResourceBindings &&
        prev.conversationMcpResources === next.conversationMcpResources &&
        prev.urlBookmarks === next.urlBookmarks &&
        prev.conversationUrlBookmarks === next.conversationUrlBookmarks
      ) {
        return
      }

      const streamingConversationIds = new Set(state.typingConversationIds)

      const ops = [
        ...(prev.workspaces !== next.workspaces
          ? diffWorkspaces(prev.workspaces, next.workspaces)
          : []),
        ...(prev.documents !== next.documents
          ? diffDocuments(prev.documents, next.documents)
          : []),
        ...(prev.conversations !== next.conversations
          ? diffConversations(prev.conversations, next.conversations, {
              streamingConversationIds,
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

      for (const op of ops) enqueue(op)

      lastSnapshot = next
    })

    return () => unsubscribe()
  }, [enabled, userId])

  // When a conversation transitions out of the streaming set, re-diff
  // it so the final assistant message lands in Supabase (in-flight
  // diffs skip its messages intentionally). Tracks the previous set
  // so we know which ids just *exited*.
  const prevTypingIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    return useStore.subscribe((state) => {
      if (!enabled || !userId) return
      const currentIds = new Set(state.typingConversationIds)
      const justFinished: string[] = []
      for (const id of prevTypingIds.current) {
        if (!currentIds.has(id)) justFinished.push(id)
      }
      if (justFinished.length > 0) {
        const prev = lastSnapshot
        if (prev) {
          // Diff with an empty streaming set so message diffs run for
          // the just-finished conversations (the other still-streaming
          // ones are already being skipped at the next scheduled diff).
          const ops = diffConversations(prev.conversations, state.conversations, {
            streamingConversationIds: new Set(),
          })
          for (const op of ops) enqueue(op)
          lastSnapshot = { ...prev, conversations: state.conversations }
        }
      }
      prevTypingIds.current = currentIds
    })
  }, [enabled, userId])
}

/**
 * Imperative helper for the reconciliation flow. Call right after
 * hydrating Zustand from the cloud so the next diff doesn't re-upload
 * the rows we just downloaded.
 *
 * Reads the current store state — so it MUST be called AFTER the store
 * has the new snapshot. If you can hand the snapshot in directly, prefer
 * `setSyncSnapshot()` and call it BEFORE the setState — that way
 * `useSync`'s subscriber sees prev === next on the synchronous
 * notification.
 */
export function seedSyncSnapshot(): void {
  lastSnapshot = takeSnapshot()
}

/**
 * Synchronously sets the diff baseline. Use this when you already have
 * the exact snapshot you're about to commit to the store, so the
 * Zustand subscriber fires with `prev === next` and emits zero ops.
 */
export function setSyncSnapshot(snapshot: {
  workspaces: Workspace[]
  documents: Document[]
  conversations: Conversation[]
  files: UploadedFile[]
  resources: Resource[]
  conversationFiles: ConversationFile[]
  notes: Note[]
  artifacts: Artifact[]
  mcpServers: McpServer[]
  mcpResources: McpResource[]
  mcpResourceBindings: McpResourceBinding[]
  conversationMcpResources: ConversationMcpResource[]
  urlBookmarks: UrlBookmark[]
  conversationUrlBookmarks: ConversationUrlBookmark[]
}): void {
  lastSnapshot = snapshot
}
