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
  diffDocuments,
  diffFiles,
  diffNotes,
  diffResources,
  diffWorkspaces,
} from "@/client/sync/handlers"
import type {
  Artifact,
  Conversation,
  ConversationFile,
  Document,
  Note,
  Resource,
  UploadedFile,
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
        prev.artifacts === next.artifacts
      ) {
        return
      }

      const streamingConversationId = state.isTyping
        ? state.activeConversationId
        : null

      const ops = [
        ...(prev.workspaces !== next.workspaces
          ? diffWorkspaces(prev.workspaces, next.workspaces)
          : []),
        ...(prev.documents !== next.documents
          ? diffDocuments(prev.documents, next.documents)
          : []),
        ...(prev.conversations !== next.conversations
          ? diffConversations(prev.conversations, next.conversations, {
              streamingConversationId,
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
      ]

      for (const op of ops) enqueue(op)

      lastSnapshot = next
    })

    return () => unsubscribe()
  }, [enabled, userId])

  // When `isTyping` transitions false, re-diff the active conversation
  // so the final streamed assistant message lands in Supabase (in-flight
  // diffs skip it intentionally).
  const wasTyping = useRef(false)
  useEffect(() => {
    return useStore.subscribe((state) => {
      if (!enabled || !userId) return
      const isTyping = state.isTyping
      if (wasTyping.current && !isTyping) {
        const prev = lastSnapshot
        if (prev) {
          const ops = diffConversations(prev.conversations, state.conversations, {
            streamingConversationId: null,
          })
          for (const op of ops) enqueue(op)
          lastSnapshot = { ...prev, conversations: state.conversations }
        }
      }
      wasTyping.current = isTyping
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
}): void {
  lastSnapshot = snapshot
}
