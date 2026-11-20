import "client-only"
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import { offloadFileBlobs } from "@/client/files/blob-fields"
import {
  deleteMessageBlobs,
  offloadMessageBlobs,
  primeMessageBlobCache,
  removedMessageBlobKeys,
} from "@/client/messages/message-blobs"

import { debouncedStorage } from "./store/debounced-storage"
import { runMigrations, STORE_VERSION } from "./store/migrate"
import { partializeState, reviveAndPruneState } from "./store/persist"
import { createChatSlice, type ChatSlice } from "./store/slices/chat"
import {
  createPromptsSlice,
  useWorkspacePrompts,
  type PromptsSlice,
} from "./store/slices/prompts"
import {
  createNotesSlice,
  useConversationNotes,
  useMessageBookmark,
  useWorkspaceNotes,
  type NotesSlice,
} from "./store/slices/notes"
import {
  createArtifactsSlice,
  useConversationArtifacts,
  useConversationSelectedArtifactIds,
  useWorkspaceArtifacts,
  type ArtifactsSlice,
} from "./store/slices/artifacts"
import {
  createProjectTasksSlice,
  useWorkspaceProjectTasks,
  type ProjectTasksSlice,
} from "./store/slices/project-tasks"
import {
  createDocumentsSlice,
  useActiveDocument,
  useActiveDocumentContent,
  useWorkspaceDocuments,
  type DocumentsSlice,
} from "./store/slices/documents"
import {
  createUrlBookmarksSlice,
  useConversationPrivateUrlBookmarks,
  useConversationSelectedUrlBookmarkIds,
  useWorkspaceUrlBookmarks,
  type UrlBookmarksSlice,
} from "./store/slices/url-bookmarks"
import {
  createUiSlice,
  useConversationPinnedExplanations,
  type PendingSelectionAction,
  type UiSlice,
} from "./store/slices/ui"
import {
  createAccountInstructionsSlice,
  type AccountInstructionsSlice,
} from "./store/slices/account-instructions"
import { createFilesSlice, type FilesSlice } from "./store/slices/files"
import { createAgentsSlice, type AgentsSlice } from "./store/slices/agents"
import {
  createUserSkillsSlice,
  type UserSkillsSlice,
} from "./store/slices/user-skills"
import { createMessagesSlice, type MessagesSlice } from "./store/slices/messages"
import {
  createWorkspacesSlice,
  useActiveWorkspace,
  type WorkspacesSlice,
} from "./store/slices/workspaces"
import {
  createConversationsSlice,
  useActiveConversation,
  useIsConversationTyping,
  useWorkspaceConversations,
  type ConversationsSlice,
} from "./store/slices/conversations"
import {
  createResourcesSlice,
  useWorkspaceResources,
  type ResourcesSlice,
} from "./store/slices/resources"
import {
  createConversationFilesSlice,
  useConversationPrivateFiles,
  useConversationSelectedFileIds,
  type ConversationFilesSlice,
} from "./store/slices/conversation-files"
import {
  createMcpSlice,
  useConversationPrivateMcpResources,
  useConversationSelectedMcpResourceIds,
  useWorkspaceMcpResources,
  useWorkspaceMcpServers,
  type McpSlice,
} from "./store/slices/mcp"

export type {
  UploadedFile,
  Workspace,
  Document,
  Resource,
  ConversationFile,
  McpServer,
  McpResource,
  McpResourceBinding,
  ConversationMcpResource,
  McpCapabilities,
  McpCredentialMode,
  UrlBookmark,
  ConversationUrlBookmark,
  Message,
  MessageError,
  Conversation,
  MainView,
  Note,
  Artifact,
  ArtifactKind,
  GeneratedImage,
  ToolCallRecord,
} from '@/shared/types'

// Track hydration state for SSR/client synchronization. We expose it via
// useSyncExternalStore so subscribers update when Zustand's persist
// middleware finishes loading from localStorage. Server snapshot is
// always `false` to keep SSR + first client paint consistent; the flip
// to `true` happens after hydration, post-mount.
let hasHydratedInternal = false
const hydrationSubscribers = new Set<() => void>()
function subscribeHydration(callback: () => void): () => void {
  hydrationSubscribers.add(callback)
  return () => {
    hydrationSubscribers.delete(callback)
  }
}
function notifyHydrated(): void {
  hasHydratedInternal = true
  for (const cb of hydrationSubscribers) cb()
}
export const useHydrated = () =>
  useSyncExternalStore(
    subscribeHydration,
    () => hasHydratedInternal,
    () => false
  )


/**
 * The full composed store. Each member entity lives in its own slice
 * under `store/slices/`; `AppState` is the union of every slice's state +
 * actions. See `docs/PLAN-store-slice-split.md` for the layout. To find a
 * mutator, open the slice named for its entity (e.g. `deleteWorkspace` →
 * `store/slices/workspaces.ts`).
 */
export interface AppState
  extends ChatSlice,
    PromptsSlice,
    NotesSlice,
    ArtifactsSlice,
    ProjectTasksSlice,
    DocumentsSlice,
    UrlBookmarksSlice,
    UiSlice,
    FilesSlice,
    ResourcesSlice,
    ConversationFilesSlice,
    McpSlice,
    AgentsSlice,
    UserSkillsSlice,
    MessagesSlice,
    WorkspacesSlice,
    ConversationsSlice,
    AccountInstructionsSlice {}

/** localStorage key of the persisted main store. */
export const STORE_STORAGE_KEY = 'hummingbird-storage'

/** The debounced storage behind `useStore`'s persist middleware.
 *  Exported for the cross-tab merge (`store/cross-tab-sync.ts`), which
 *  needs to inspect / drop this tab's buffered write. */
export const persistStorage = debouncedStorage()

export const useStore = create<AppState>()(
  persist(
    (set, get, api) => ({
      // --- Extracted slices (PLAN-store-slice-split) -------------------
      ...createChatSlice(set, get, api),
      ...createPromptsSlice(set, get, api),
      ...createNotesSlice(set, get, api),
      ...createArtifactsSlice(set, get, api),
      ...createProjectTasksSlice(set, get, api),
      ...createDocumentsSlice(set, get, api),
      ...createUrlBookmarksSlice(set, get, api),
      ...createUiSlice(set, get, api),
      ...createFilesSlice(set, get, api),
      ...createResourcesSlice(set, get, api),
      ...createConversationFilesSlice(set, get, api),
      ...createMcpSlice(set, get, api),
      ...createAgentsSlice(set, get, api),
      ...createUserSkillsSlice(set, get, api),
      ...createMessagesSlice(set, get, api),
      ...createWorkspacesSlice(set, get, api),
      ...createConversationsSlice(set, get, api),
      ...createAccountInstructionsSlice(set, get, api),
    }),
    {
      name: STORE_STORAGE_KEY,
      version: STORE_VERSION,
      migrate: runMigrations,
      onRehydrateStorage: () => (state) => {
        if (state) reviveAndPruneState(state)
        // Make inline message `data:` URLs (pre-v33 data, or an offload
        // that never committed) resolvable right away — the sync queue
        // may flush a persisted op carrying their references before the
        // deferred offload below runs.
        if (state) primeMessageBlobCache(state.conversations)
        notifyHydrated()
        // Move any blob fields still carried by the rehydrated rows
        // (pre-v32 / pre-v33 data, or a previous offload that never
        // committed) into IndexedDB. Deferred: hydration can run inside
        // `create()`, before `useStore` is assigned.
        setTimeout(scheduleFileBlobOffload, 0)
        setTimeout(scheduleMessageBlobOffload, 0)
      },
      partialize: partializeState,
      // Coalesce localStorage writes — the default storage writes the
      // full partialized state on every mutation; with 28 persisted
      // keys + per-token SSE updates that's a meaningful amount of
      // JSON.stringify churn. The wrapper flushes on `pagehide` so
      // committed state survives navigation.
      storage: createJSONStorage(() => persistStorage),
    }
  )
)

// --- Blob-field offload (v32, `client/files/blob-fields.ts`) -------------
// Every `files` change may carry a new `imageDataUrl` / `extractedFullText`
// (upload, re-extraction, cloud pull, cross-tab merge). Write those to
// IndexedDB; once committed, `partializeState` strips them — so poke the
// persist middleware (`setState({})`) to rewrite localStorage without them.
let offloadRepersistQueued = false
function repersistAfterOffload(becameDurable: boolean): void {
  if (!becameDurable || offloadRepersistQueued) return
  offloadRepersistQueued = true
  queueMicrotask(() => {
    offloadRepersistQueued = false
    useStore.setState({})
  })
}
function scheduleFileBlobOffload(): void {
  void offloadFileBlobs(useStore.getState().files).then(repersistAfterOffload)
}

// --- Message blob offload (v33, `client/messages/message-blobs.ts`) -------
// Same pattern for the inline `data:` URLs on message generated images /
// files: write them to IndexedDB; once committed `partializeState` swaps
// them for `hb-blob:` references. Only conversation objects the offload
// hasn't walked yet are visited, so per-token stream updates stay cheap.
function scheduleMessageBlobOffload(): void {
  void offloadMessageBlobs(useStore.getState().conversations).then(
    repersistAfterOffload
  )
}

useStore.subscribe((state, prev) => {
  if (state.files !== prev.files) scheduleFileBlobOffload()
  if (state.conversations !== prev.conversations) {
    scheduleMessageBlobOffload()
    // Cascade: IndexedDB records no message references any more (message
    // / conversation / workspace deleted, thread truncated, a pull that
    // dropped the row). Keys still referenced elsewhere — e.g. by a
    // fork's copied placeholder — are kept.
    const orphaned = removedMessageBlobKeys(prev.conversations, state.conversations)
    if (orphaned.length > 0) void deleteMessageBlobs(orphaned)
  }
})

// Separate store for session-based state (cleared when browser tab is closed)
interface SessionState {
  selectedFileIds: string[]
  toggleFileSelection: (fileId: string) => void
  setSelectedFileIds: (ids: string[]) => void
  clearSelectedFiles: () => void
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      selectedFileIds: [],
      toggleFileSelection: (fileId: string) =>
        set((state) => ({
          selectedFileIds: state.selectedFileIds.includes(fileId)
            ? state.selectedFileIds.filter((id) => id !== fileId)
            : [...state.selectedFileIds, fileId],
        })),
      setSelectedFileIds: (ids: string[]) => set({ selectedFileIds: ids }),
      clearSelectedFiles: () => set({ selectedFileIds: [] }),
    }),
    {
      name: 'hummingbird-session',
      storage: (typeof window !== 'undefined')
        ? createJSONStorage(() => sessionStorage)
        : undefined,
    }
  )
)

// Helper selectors
export { useActiveWorkspace }
export {
  useActiveConversation,
  useIsConversationTyping,
  useWorkspaceConversations,
}

export { useWorkspaceResources }
export { useConversationPrivateFiles, useConversationSelectedFileIds }

export {
  useWorkspaceMcpServers,
  useWorkspaceMcpResources,
  useConversationPrivateMcpResources,
  useConversationSelectedMcpResourceIds,
}

export {
  useWorkspaceUrlBookmarks,
  useConversationPrivateUrlBookmarks,
  useConversationSelectedUrlBookmarkIds,
}

export { useConversationNotes, useWorkspaceNotes, useMessageBookmark }

export { useWorkspacePrompts }
export {
  useWorkspaceDocuments,
  useActiveDocument,
  useActiveDocumentContent,
}

export { useConversationArtifacts, useWorkspaceArtifacts, useConversationSelectedArtifactIds }

export { useConversationPinnedExplanations }
export type { PendingSelectionAction }

export { useWorkspaceProjectTasks }
