import "client-only"
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  UploadedFile,
  Workspace,
  Message,
  Conversation,
} from '@/shared/types'
import {
  bulkTombstoneByKind,
  cloneAttachmentSelections,
  forkConversationJoins,
  gcOrphanedAttachment,
  gcOrphanedAttachments,
  type AttachmentRef,
} from '@/client/store/cascade'
import { uuid } from '@/shared/uuid'

// Short, URL-safe id for prompts. Re-uses the existing uuid helper so we
// don't add a nanoid dep; the slice doesn't need RFC4122 cryptographic
// uniqueness, just unique-within-a-user's-library.
import {
  mergeFileSearchConfig,
  mergeImageGenConfig,
  mergeWebFetchConfig,
  mergeWebSearchConfig,
  tombstoneMcpServer,
} from "./store-helpers"
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
import { createFilesSlice, type FilesSlice } from "./store/slices/files"
import { createAgentsSlice, type AgentsSlice } from "./store/slices/agents"
import { createMessagesSlice, type MessagesSlice } from "./store/slices/messages"
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

// Default initial values for store
const DEFAULT_WORKSPACE_ID = 'default'

const getDefaultWorkspaces = (): Workspace[] => {
  const now = new Date('2024-01-01T12:00:00Z')
  return [
    {
      id: DEFAULT_WORKSPACE_ID,
      name: 'My Workspace',
      createdAt: now,
      updatedAt: now,
    },
  ]
}

const getDefaultConversations = (): Conversation[] => {
  const baseTime = new Date('2024-01-01T12:00:00Z').getTime()
  return [
    {
      id: 'demo-1',
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: 'Welcome',
      // Empty by design — the chat panel renders <EmptyChatWelcome> when
      // there are no messages, with feature bullets and suggestion chips.
      // Leaving stale pretend-messages here makes the app feel like a
      // demo someone forgot to wipe before shipping.
      messages: [],
      createdAt: new Date(baseTime - 120000),
      updatedAt: new Date(baseTime),
      pinned: true,
      selectedFileIds: [],
    },
  ]
}

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
    MessagesSlice {
  // UI state (theme, colorScheme, activeView, sidebars/panels,
  // editorPrefs, pins, selection bus, local-only/local-files toggles,
  // pendingChatInput) — see UiSlice in store/slices/ui.ts.

  // Files — see FilesSlice in store/slices/files.ts (files[] + add/
  // remove/clear/setExtraction/setStorage).

  // Workspaces
  workspaces: Workspace[]
  activeWorkspaceId: string

  // Project mode — Kanban cards. See ProjectTasksSlice in
  // store/slices/project-tasks.ts (projectTasks[] + create/update/
  // move/delete).

  // Documents — see DocumentsSlice in store/slices/documents.ts
  // (documents[] + activeDocumentId + create/delete/rename/setContent/
  // append/setActive/appendToActiveOrCreate).

  // Resources (file-to-workspace) — see ResourcesSlice.
  // Conversation-private files (file-to-conversation join) — see
  // ConversationFilesSlice.

  // MCP — see McpSlice in store/slices/mcp.ts (mcpServers[] +
  // mcpResources[] + mcpResourceBindings[] + conversationMcpResources[]
  // + server/resource/binding/join actions).

  // URL bookmarks — see UrlBookmarksSlice in store/slices/url-bookmarks.ts
  // (urlBookmarks[] + conversationUrlBookmarks[] + add/update/remove/
  // private-pin/toggle-selection).

  // Notes — see NotesSlice in store/slices/notes.ts (notes[] +
  // create/update/delete/toggleMessageBookmark).

  // Artifacts — see ArtifactsSlice in store/slices/artifacts.ts
  // (artifacts[] + editorReloadToken + create/delete/togglePin/
  // updateTitle/requestEditorReload).

  // Prompts — see PromptsSlice in store/slices/prompts.ts
  // (prompts[] + create/update/delete/restore).

  // Custom agents / personas — see AgentsSlice in store/slices/agents.ts
  // (agents[] + activeAgentId + create/update/delete/restore/setActive).

  // pendingChatInput — see UiSlice.

  // Conversations
  conversations: Conversation[]
  activeConversationId: string | null

  // Chat — see ChatSlice in store/slices/chat.ts (typingConversationIds,
  // streamingContent, chatModel, pendingReferenceImage,
  // sessionModelOverridden + their setters).

  // View / sidebar / theme / pins / selection actions — see UiSlice.

  // Workspace actions
  createWorkspace: (name: string) => Workspace
  /** Reorder workspaces by id. Unknown ids are dropped; missing ids keep
   *  their relative tail order. */
  reorderWorkspaces: (orderedIds: string[]) => void
  deleteWorkspace: (workspaceId: string) => void
  renameWorkspace: (workspaceId: string, name: string) => void
  setWorkspaceSystemPrompt: (workspaceId: string, prompt: string) => void
  /** Patch the project-mode config on a workspace (toggle / goal /
   *  milestones). Only the keys present in `patch` are written, so
   *  e.g. flipping the toggle leaves an existing goal untouched. See
   *  `docs/PLAN-project-mode.md`. */
  setWorkspaceProjectConfig: (
    workspaceId: string,
    patch: Partial<Pick<Workspace, "isProject" | "goal" | "milestones">>
  ) => void
  /** Pin a default chat model on a workspace. Empty string clears the pin. */
  setWorkspaceDefaultModel: (workspaceId: string, modelId: string) => void
  /** Set a workspace skill default. `null` clears the entry (skill returns to default). */
  setWorkspaceSkillPref: (workspaceId: string, skillId: string, value: boolean | null) => void
  /** Patch the workspace-level `webSearch` config. Pass a partial
   *  `WebSearchConfig`; provided fields overwrite, others are kept.
   *  Setting a leaf to `undefined` (or the whole config to `null`)
   *  drops that override so the level below in the cascade takes
   *  over. */
  patchWorkspaceWebSearchConfig: (
    workspaceId: string,
    patch: Partial<import("@/shared/skills/web-search-config").WebSearchConfig> | null
  ) => void
  /** Patch the workspace-level `webFetch` config. Same cascade
   *  semantics as `patchWorkspaceWebSearchConfig`. */
  patchWorkspaceWebFetchConfig: (
    workspaceId: string,
    patch: Partial<import("@/shared/skills/web-fetch-config").WebFetchConfig> | null
  ) => void
  /** Patch the workspace-level `imageGen` config. Same cascade
   *  semantics as `patchWorkspaceWebSearchConfig`. */
  patchWorkspaceImageGenConfig: (
    workspaceId: string,
    patch: Partial<import("@/shared/skills/image-gen-config").ImageGenConfig> | null
  ) => void
  /** Patch the workspace-level `searchFiles` config. Same cascade
   *  semantics as `patchWorkspaceWebFetchConfig`. */
  patchWorkspaceFileSearchConfig: (
    workspaceId: string,
    patch: Partial<import("@/shared/skills/file-search-config").FileSearchConfig> | null
  ) => void
  /** Replace the workspace's spatial-canvas layout wholesale. Unlike the
   *  skill-config patchers this is a full set (the canvas panel owns the
   *  in-session React Flow state and writes the settled snapshot back on
   *  drag-stop / connect / add / delete). `null` clears the canvas. */
  setWorkspaceCanvasState: (
    workspaceId: string,
    state: import("@/shared/canvas/types").CanvasState | null
  ) => void
  setActiveWorkspace: (workspaceId: string) => void

  // Resource actions — see ResourcesSlice.
  // Conversation-private file actions — see ConversationFilesSlice.

  // MCP server + resource actions — see McpSlice.



  // Agent / persona actions — see AgentsSlice.

  // setPendingChatInput — see UiSlice.

  // File actions — see FilesSlice.

  // Conversation actions
  createConversation: (workspaceId?: string) => Conversation
  /**
   * Branch a conversation at a specific message. Returns a new conversation
   * that contains a copy of every message up to and including `untilMessageId`,
   * inherits the source's workspace + selected files + document content +
   * skill prefs, and is set as active. Messages get fresh ids so the two
   * threads can diverge independently.
   */
  forkConversation: (conversationId: string, untilMessageId: string) => Conversation | null
  deleteConversation: (conversationId: string) => void
  renameConversation: (conversationId: string, title: string) => void
  /** Set a conversation skill override. `null` clears the entry (falls back to workspace default). */
  setConversationSkillPref: (conversationId: string, skillId: string, value: boolean | null) => void
  /** Patch the per-conversation `webSearch` config override (same shape
   *  and semantics as `patchWorkspaceWebSearchConfig`). */
  patchConversationWebSearchConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/web-search-config").WebSearchConfig> | null
  ) => void
  /** Patch the per-conversation `webFetch` config override (same shape
   *  and semantics as `patchWorkspaceWebFetchConfig`). */
  patchConversationWebFetchConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/web-fetch-config").WebFetchConfig> | null
  ) => void
  /** Patch the per-conversation `imageGen` config override. */
  patchConversationImageGenConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/image-gen-config").ImageGenConfig> | null
  ) => void
  /** Patch the per-conversation `searchFiles` config override (same shape
   *  and semantics as `patchWorkspaceFileSearchConfig`). */
  patchConversationFileSearchConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/file-search-config").FileSearchConfig> | null
  ) => void
  // toggleConversationFileSelection / clearConversationFileSelection —
  // see ConversationFilesSlice.
  togglePin: (conversationId: string) => void
  setActiveConversation: (conversationId: string | null) => void

  // Message actions — see MessagesSlice.

  // Theme actions + colorScheme — see UiSlice.
}

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
      ...createMessagesSlice(set, get, api),

      // Files — see FilesSlice

      // Workspaces
      workspaces: getDefaultWorkspaces(),
      activeWorkspaceId: DEFAULT_WORKSPACE_ID,

      // Documents — see DocumentsSlice

      // Resources — see ResourcesSlice
      // Conversation-private files — see ConversationFilesSlice

      // MCP — see McpSlice

      // URL bookmarks — see UrlBookmarksSlice

      // Notes — see NotesSlice

      // Artifacts — see ArtifactsSlice

      // Prompts (Phase 1: local-only) — see PromptsSlice
      // Agents / personas — see AgentsSlice

      // Project mode (Kanban cards) — see ProjectTasksSlice

      // Conversations
      conversations: getDefaultConversations().map((c: Conversation) => ({
        ...c,
        pinned: c.pinned ?? false,
        selectedFileIds: c.selectedFileIds ?? [],
      })),
      activeConversationId: 'demo-1',

      // Workspace actions
      createWorkspace: (name: string) => {
        const newWorkspace: Workspace = {
          id: uuid(),
          name,
          createdAt: new Date(),
          updatedAt: new Date(),
          // Goes to the front of the list — position 0 — and the existing
          // workspaces shift by 1. Single update so the diff fires once.
          position: 0,
        }
        set((state) => ({
          workspaces: [
            newWorkspace,
            ...state.workspaces.map((w, i) => ({ ...w, position: i + 1 })),
          ],
        }))
        return newWorkspace
      },
      reorderWorkspaces: (orderedIds: string[]) =>
        set((state) => {
          const byId = new Map(state.workspaces.map((w) => [w.id, w]))
          const reordered: Workspace[] = []
          for (const id of orderedIds) {
            const w = byId.get(id)
            if (w) {
              reordered.push(w)
              byId.delete(id)
            }
          }
          // Append any workspaces not mentioned by the caller (defensive
          // against partial id lists).
          for (const w of byId.values()) reordered.push(w)
          // Stamp positions so the cross-device sync can reproduce the
          // order. Bump updatedAt too so the diff fires the upsert
          // (position alone would still be picked up via workspaceEquals,
          // but bumping updatedAt keeps "last touched" honest).
          const now = new Date()
          return {
            workspaces: reordered.map((w, i) =>
              w.position === i ? w : { ...w, position: i, updatedAt: now }
            ),
          }
        }),
      deleteWorkspace: (workspaceId: string) =>
        set((state) => {
          if (state.workspaces.length <= 1) return state // Prevent deleting last workspace
          const newWorkspaces = state.workspaces.filter((w) => w.id !== workspaceId)
          const newActiveWorkspaceId = state.activeWorkspaceId === workspaceId
            ? newWorkspaces[0]?.id
            : state.activeWorkspaceId
          // Cascade: drop resources, conversations, notes, artifacts, and
          // documents that belonged to the workspace.
          const newResources = state.resources.filter((r) => r.workspaceId !== workspaceId)
          const newConversations = state.conversations.filter((c) => c.workspaceId !== workspaceId)
          const newNotes = state.notes.filter((n) => n.workspaceId !== workspaceId)
          const newArtifacts = state.artifacts.filter((a) => a.workspaceId !== workspaceId)
          const newDocuments = state.documents.filter((d) => d.workspaceId !== workspaceId)
          const newProjectTasks = state.projectTasks.filter((t) => t.workspaceId !== workspaceId)
          // Drop conversation-private joins whose conversation lived in
          // this workspace, then GC files that lost their last reference.
          // `gcOrphanedAttachments` does the ref-count + tombstone logic;
          // its internal dedup stops it from running twice on the same
          // file id when multiple deleted conversations had it privately
          // attached.
          //
          // Two sources of orphan candidates:
          //   1. Files attached to a deleted conversation via the
          //      private `conversationFiles` join.
          //   2. Files held in the workspace library via a `resources`
          //      row in the deleted workspace. Without these, a file
          //      attached *only* via the workspace library (no private
          //      join) would leak as an untombstoned row after its
          //      workspace went away.
          const droppedConvIds = new Set(
            state.conversations
              .filter((c) => c.workspaceId === workspaceId)
              .map((c) => c.id)
          )
          const droppedFileRefs: AttachmentRef[] = [
            ...state.conversationFiles
              .filter((cf) => droppedConvIds.has(cf.conversationId))
              .map((cf) => ({ kind: 'file' as const, id: cf.fileId })),
            ...state.resources
              .filter((r) => r.workspaceId === workspaceId)
              .map((r) => ({ kind: 'file' as const, id: r.fileId })),
          ]
          const newConversationFiles = state.conversationFiles.filter(
            (cf) => !droppedConvIds.has(cf.conversationId)
          )
          // If the active doc lived in the deleted workspace, swap to the
          // most-recently-updated doc in the new active workspace (if any).
          let newActiveDocumentId = state.activeDocumentId
          if (
            state.activeDocumentId &&
            !newDocuments.some((d) => d.id === state.activeDocumentId)
          ) {
            const fallback = newDocuments
              .filter((d) => d.workspaceId === newActiveWorkspaceId)
              .sort(
                (a, b) =>
                  new Date(b.updatedAt).getTime() -
                  new Date(a.updatedAt).getTime()
              )[0]
            newActiveDocumentId = fallback?.id ?? null
          }
          // MCP cascade: tombstone every server in the workspace, then
          // tombstone their resources via `bulkTombstoneByKind`, drop
          // matching bindings and conversation joins. The metadata
          // stubs (server, resource) remain so historic message
          // references stay resolvable.
          const droppedServerIds = new Set(
            state.mcpServers
              .filter((s) => s.workspaceId === workspaceId && !s.deletedAt)
              .map((s) => s.id)
          )
          const droppedResourceIds = new Set(
            state.mcpResources
              .filter((r) => droppedServerIds.has(r.serverId) && !r.deletedAt)
              .map((r) => r.id)
          )
          const newMcpServers = state.mcpServers.map((s) =>
            droppedServerIds.has(s.id) ? tombstoneMcpServer(s) : s
          )
          const mcpTombstones = bulkTombstoneByKind(state, 'mcp_resource', droppedResourceIds)
          const newMcpBindings = state.mcpResourceBindings.filter(
            (b) => !droppedResourceIds.has(b.resourceId)
          )
          const newConvMcpResources = state.conversationMcpResources.filter(
            (cmr) => !droppedResourceIds.has(cmr.resourceId)
          )
          // URL bookmarks cascade — same shape as MCP. Selection ids on
          // the (now-deleted) conversations don't need stripping since
          // the conversations themselves are gone.
          const droppedBookmarkIds = new Set(
            state.urlBookmarks
              .filter((b) => b.workspaceId === workspaceId && !b.deletedAt)
              .map((b) => b.id)
          )
          const urlTombstones = bulkTombstoneByKind(state, 'url_bookmark', droppedBookmarkIds)
          const newConvUrlBookmarks = state.conversationUrlBookmarks.filter(
            (cub) => !droppedBookmarkIds.has(cub.bookmarkId)
          )
          const patch: Partial<AppState> = {
            workspaces: newWorkspaces,
            activeWorkspaceId: newActiveWorkspaceId,
            resources: newResources,
            conversations: newConversations,
            conversationFiles: newConversationFiles,
            notes: newNotes,
            artifacts: newArtifacts,
            documents: newDocuments,
            projectTasks: newProjectTasks,
            activeDocumentId: newActiveDocumentId,
            mcpServers: newMcpServers,
            mcpResourceBindings: newMcpBindings,
            conversationMcpResources: newConvMcpResources,
            conversationUrlBookmarks: newConvUrlBookmarks,
            ...mcpTombstones,
            ...urlTombstones,
          }
          // GC files whose last private-join reference lived on a
          // conversation in the deleted workspace.
          return {
            ...patch,
            ...gcOrphanedAttachments({ ...state, ...patch }, droppedFileRefs),
          }
        }),
      renameWorkspace: (workspaceId: string, name: string) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, name, updatedAt: new Date() } : w
          ),
        })),
      setWorkspaceSystemPrompt: (workspaceId: string, prompt: string) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === workspaceId
              ? { ...w, systemPrompt: prompt, updatedAt: new Date() }
              : w
          ),
        })),
      setWorkspaceProjectConfig: (workspaceId, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            const next = { ...w, updatedAt: new Date() }
            if ("isProject" in patch) next.isProject = patch.isProject
            if ("goal" in patch) next.goal = patch.goal
            if ("milestones" in patch) next.milestones = patch.milestones
            return next
          }),
        })),
      setWorkspaceDefaultModel: (workspaceId: string, modelId: string) =>
        set((state) => {
          const trimmed = modelId.trim()
          const value = trimmed.length === 0 ? undefined : trimmed
          const isActive = state.activeWorkspaceId === workspaceId
          return {
            workspaces: state.workspaces.map((w) =>
              w.id === workspaceId
                ? { ...w, defaultModel: value, updatedAt: new Date() }
                : w
            ),
            // Apply immediately when the user pins a default on the *current*
            // workspace AND hasn't manually overridden the session model. The
            // intent is "from now on, this workspace = this model" — waiting
            // until the next workspace switch to apply would feel inert.
            chatModel:
              isActive && value && !state.sessionModelOverridden
                ? value
                : state.chatModel,
          }
        }),
      setWorkspaceSkillPref: (workspaceId, skillId, value) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            const current = w.skillPrefs ?? {}
            const next: Record<string, boolean> = { ...current }
            if (value === null) delete next[skillId]
            else next[skillId] = value
            return { ...w, skillPrefs: next, updatedAt: new Date() }
          }),
        })),
      patchWorkspaceWebSearchConfig: (workspaceId, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            if (patch === null) {
              const { webSearchConfig: _drop, ...rest } = w
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeWebSearchConfig(w.webSearchConfig, patch)
            return { ...w, webSearchConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchWorkspaceWebFetchConfig: (workspaceId, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            if (patch === null) {
              const { webFetchConfig: _drop, ...rest } = w
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeWebFetchConfig(w.webFetchConfig, patch)
            return { ...w, webFetchConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchWorkspaceImageGenConfig: (workspaceId, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            if (patch === null) {
              const { imageGenConfig: _drop, ...rest } = w
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeImageGenConfig(w.imageGenConfig, patch)
            return { ...w, imageGenConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchWorkspaceFileSearchConfig: (workspaceId, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            if (patch === null) {
              const { fileSearchConfig: _drop, ...rest } = w
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeFileSearchConfig(w.fileSearchConfig, patch)
            return { ...w, fileSearchConfig: merged, updatedAt: new Date() }
          }),
        })),
      setWorkspaceCanvasState: (workspaceId, canvasState) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            if (canvasState === null) {
              const { canvasState: _drop, ...rest } = w
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            return { ...w, canvasState, updatedAt: new Date() }
          }),
        })),
      setActiveWorkspace: (workspaceId: string) =>
        set((state) => {
          if (workspaceId === state.activeWorkspaceId) {
            return { activeWorkspaceId: workspaceId }
          }
          const next = state.workspaces.find((w) => w.id === workspaceId)
          const pinned = next?.defaultModel
          // Pick the new workspace's most-recently-updated doc as the
          // active one so the editor opens to something familiar.
          // Falls through to null when the workspace has no docs yet.
          const nextDoc = state.documents
            .filter((d) => d.workspaceId === workspaceId)
            .sort(
              (a, b) =>
                new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
            )[0]
          return {
            activeWorkspaceId: workspaceId,
            activeDocumentId: nextDoc?.id ?? null,
            // Apply the new workspace's pinned model (or keep the current
            // one if it doesn't have a pin). Crossing into a new workspace
            // resets the session-override flag — picking a model in the
            // previous workspace was per-that-workspace intent.
            chatModel: pinned ?? state.chatModel,
            sessionModelOverridden: false,
          }
        }),


      // Conversation actions
      createConversation: (workspaceId?: string) => {
        const activeWorkspaceId = workspaceId || get().activeWorkspaceId
        const newConversation: Conversation = {
          id: uuid(),
          workspaceId: activeWorkspaceId,
          title: `New Chat ${get().conversations.filter(c => c.workspaceId === activeWorkspaceId).length + 1}`,
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          pinned: false,
          selectedFileIds: [],
        }
        set((state) => ({
          conversations: [newConversation, ...state.conversations],
          activeConversationId: newConversation.id,
        }))
        return newConversation
      },
      forkConversation: (conversationId, untilMessageId) => {
        const source = get().conversations.find((c) => c.id === conversationId)
        if (!source) return null
        const idx = source.messages.findIndex((m) => m.id === untilMessageId)
        if (idx === -1) return null
        const slice = source.messages.slice(0, idx + 1)
        // Re-id messages so edits to either branch don't bleed across.
        // Keep timestamps + content + reasoning + attachments intact so
        // the fork reads as a faithful copy of the past.
        const copiedMessages: Message[] = slice.map((m) => ({
          ...m,
          id: uuid(),
        }))
        const fork: Conversation = {
          id: uuid(),
          workspaceId: source.workspaceId,
          title: `${source.title} (branch)`,
          messages: copiedMessages,
          createdAt: new Date(),
          updatedAt: new Date(),
          pinned: false,
          ...cloneAttachmentSelections(source),
          skillPrefs: source.skillPrefs ? { ...source.skillPrefs } : undefined,
          parentId: source.id,
          forkedFromMessageId: untilMessageId,
        }
        set((state) => {
          // Inherit the source's conversation-private joins onto the
          // fork. Single helper covers all three lanes; the underlying
          // entities (files / MCP resources / URL bookmarks) are
          // shared via their existing ids.
          const inherited = forkConversationJoins(state, source.id, fork.id, uuid)
          return {
            conversations: [fork, ...state.conversations],
            conversationFiles: [...state.conversationFiles, ...inherited.conversationFiles],
            conversationMcpResources: [
              ...state.conversationMcpResources,
              ...inherited.conversationMcpResources,
            ],
            conversationUrlBookmarks: [
              ...state.conversationUrlBookmarks,
              ...inherited.conversationUrlBookmarks,
            ],
            activeConversationId: fork.id,
          }
        })
        return fork
      },
      deleteConversation: (conversationId: string) =>
        set((state) => {
          const newConversations = state.conversations.filter(
            (c) => c.id !== conversationId
          )
          // Drop every conversation-private join for this conversation
          // across all three lanes. Pre-collect the (kind, id) refs
          // that were orphaned so we can GC them after the join arrays
          // shrink.
          const droppedFileRefs: AttachmentRef[] = state.conversationFiles
            .filter((cf) => cf.conversationId === conversationId)
            .map((cf) => ({ kind: 'file' as const, id: cf.fileId }))
          const droppedMcpRefs: AttachmentRef[] = state.conversationMcpResources
            .filter((cmr) => cmr.conversationId === conversationId)
            .map((cmr) => ({ kind: 'mcp_resource' as const, id: cmr.resourceId }))
          const droppedUrlRefs: AttachmentRef[] = state.conversationUrlBookmarks
            .filter((cub) => cub.conversationId === conversationId)
            .map((cub) => ({ kind: 'url_bookmark' as const, id: cub.bookmarkId }))

          const remainingFileJoins = state.conversationFiles.filter(
            (cf) => cf.conversationId !== conversationId
          )
          const remainingMcpJoins = state.conversationMcpResources.filter(
            (cmr) => cmr.conversationId !== conversationId
          )
          const remainingUrlJoins = state.conversationUrlBookmarks.filter(
            (cub) => cub.conversationId !== conversationId
          )

          // Notes/artifacts are workspace-scoped, but bookmarks (notes with
          // messageId !== null) anchor to a specific message that no longer
          // exists once the conversation is gone — drop those. Free-form
          // notes and all artifacts are orphaned (conversationId → null) so
          // they remain visible at the workspace level.
          const newNotes = state.notes
            .filter(
              (n) => !(n.conversationId === conversationId && n.messageId !== null)
            )
            .map((n) =>
              n.conversationId === conversationId ? { ...n, conversationId: null } : n
            )
          const newArtifacts = state.artifacts.map((a) =>
            a.conversationId === conversationId ? { ...a, conversationId: null } : a
          )
          // Pins are session-only and conversation-scoped — drop them
          // when the conversation goes away so we don't keep dangling
          // references that would never render again.
          const newPins = state.pinnedExplanations.filter(
            (p) => p.conversationId !== conversationId
          )

          // GC each orphaned attachment against the post-drop state.
          // De-dup refs (a workspace file referenced by multiple
          // conversation joins shouldn't get tombstoned twice).
          const patch: Partial<AppState> = {
            conversations: newConversations,
            conversationFiles: remainingFileJoins,
            conversationMcpResources: remainingMcpJoins,
            conversationUrlBookmarks: remainingUrlJoins,
            notes: newNotes,
            artifacts: newArtifacts,
            pinnedExplanations: newPins,
            activeConversationId:
              state.activeConversationId === conversationId
                ? newConversations[0]?.id || null
                : state.activeConversationId,
          }
          return {
            ...patch,
            ...gcOrphanedAttachments({ ...state, ...patch }, [
              ...droppedFileRefs,
              ...droppedMcpRefs,
              ...droppedUrlRefs,
            ]),
          }
        }),
      renameConversation: (conversationId: string, title: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, title, updatedAt: new Date() } : c
          ),
        })),
      setConversationSkillPref: (conversationId, skillId, value) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const current = c.skillPrefs ?? {}
            const next: Record<string, boolean> = { ...current }
            if (value === null) delete next[skillId]
            else next[skillId] = value
            return { ...c, skillPrefs: next, updatedAt: new Date() }
          }),
        })),
      patchConversationWebSearchConfig: (conversationId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            if (patch === null) {
              const { webSearchConfig: _drop, ...rest } = c
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeWebSearchConfig(c.webSearchConfig, patch)
            return { ...c, webSearchConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchConversationWebFetchConfig: (conversationId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            if (patch === null) {
              const { webFetchConfig: _drop, ...rest } = c
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeWebFetchConfig(c.webFetchConfig, patch)
            return { ...c, webFetchConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchConversationImageGenConfig: (conversationId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            if (patch === null) {
              const { imageGenConfig: _drop, ...rest } = c
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeImageGenConfig(c.imageGenConfig, patch)
            return { ...c, imageGenConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchConversationFileSearchConfig: (conversationId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            if (patch === null) {
              const { fileSearchConfig: _drop, ...rest } = c
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeFileSearchConfig(c.fileSearchConfig, patch)
            return { ...c, fileSearchConfig: merged, updatedAt: new Date() }
          }),
        })),
      togglePin: (conversationId: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, pinned: !c.pinned } : c
          ),
        })),
      setActiveConversation: (conversationId: string | null) =>
        set({ activeConversationId: conversationId }),

      // Message actions — see createMessagesSlice (spread above).

    }),
    {
      name: 'hummingbird-storage',
      version: STORE_VERSION,
      migrate: runMigrations,
      onRehydrateStorage: () => (state) => {
        if (state) reviveAndPruneState(state)
        notifyHydrated()
      },
      partialize: partializeState,
    }
  )
)

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
export const useActiveWorkspace = () => {
  const workspaces = useStore((state) => state.workspaces)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return workspaces.find((w) => w.id === activeWorkspaceId) || null
}

export const useActiveConversation = () => {
  const conversations = useStore((state) => state.conversations)
  const activeConversationId = useStore((state) => state.activeConversationId)
  return conversations.find((c) => c.id === activeConversationId) || null
}

/** True iff the given conversation is currently mid-stream. `null`
 *  conversation id always returns false. Cheap O(n) lookup over the
 *  typing-ids array which is realistically always 0–few items long. */
export const useIsConversationTyping = (conversationId: string | null): boolean => {
  return useStore((state) =>
    conversationId !== null && state.typingConversationIds.includes(conversationId)
  )
}

export const useWorkspaceConversations = () => {
  const conversations = useStore((state) => state.conversations)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return conversations.filter((c) => c.workspaceId === activeWorkspaceId)
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

export { useConversationArtifacts, useWorkspaceArtifacts }

export { useConversationPinnedExplanations }
export type { PendingSelectionAction }

export { useWorkspaceProjectTasks }
