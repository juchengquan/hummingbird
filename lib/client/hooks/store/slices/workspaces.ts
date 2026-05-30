import "client-only"

import type { Workspace } from "@/shared/types"
import { uuid } from "@/shared/uuid"
import {
  bulkTombstoneByKind,
  gcOrphanedAttachments,
  type AttachmentRef,
} from "@/client/store/cascade"

import { useStore } from "../../use-store"
import {
  mergeFileSearchConfig,
  mergeImageGenConfig,
  mergeWebFetchConfig,
  mergeWebSearchConfig,
  tombstoneMcpServer,
} from "../../store-helpers"
import type { SliceCreator, StoreState } from "../types"

export const DEFAULT_WORKSPACE_ID = "default"

export const getDefaultWorkspaces = (): Workspace[] => {
  const now = new Date("2024-01-01T12:00:00Z")
  return [
    {
      id: DEFAULT_WORKSPACE_ID,
      name: "My Workspace",
      createdAt: now,
      updatedAt: now,
    },
  ]
}

/**
 * Workspaces slice — the top-level container entity + the active-workspace
 * pointer. Owns `deleteWorkspace`, the deepest cascade in the store: it
 * prunes the workspace's conversations, documents, resources, project
 * tasks, notes, artifacts, and conversation-private joins, tombstones its
 * MCP servers/resources + URL bookmarks, GCs files that lost their last
 * reference, and re-points the active doc. `setActiveWorkspace` also
 * re-points the active doc + applies the workspace's pinned model (both
 * cross-slice writes through the shared set).
 */
export interface WorkspacesSlice {
  workspaces: Workspace[]
  activeWorkspaceId: string

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
   *  `docs/_done/PLAN-project-mode.md`. */
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
}

export const createWorkspacesSlice: SliceCreator<WorkspacesSlice> = (set) => ({
  workspaces: getDefaultWorkspaces(),
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,

  createWorkspace: (name) => {
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
  reorderWorkspaces: (orderedIds) =>
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
  deleteWorkspace: (workspaceId) =>
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
          .map((cf) => ({ kind: "file" as const, id: cf.fileId })),
        ...state.resources
          .filter((r) => r.workspaceId === workspaceId)
          .map((r) => ({ kind: "file" as const, id: r.fileId })),
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
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
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
      const mcpTombstones = bulkTombstoneByKind(state, "mcp_resource", droppedResourceIds)
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
      const urlTombstones = bulkTombstoneByKind(state, "url_bookmark", droppedBookmarkIds)
      const newConvUrlBookmarks = state.conversationUrlBookmarks.filter(
        (cub) => !droppedBookmarkIds.has(cub.bookmarkId)
      )
      const patch: Partial<StoreState> = {
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
  renameWorkspace: (workspaceId, name) =>
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, name, updatedAt: new Date() } : w
      ),
    })),
  setWorkspaceSystemPrompt: (workspaceId, prompt) =>
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
  setWorkspaceDefaultModel: (workspaceId, modelId) =>
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
  setActiveWorkspace: (workspaceId) =>
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
})

export const useActiveWorkspace = () => {
  const workspaces = useStore((state) => state.workspaces)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return workspaces.find((w) => w.id === activeWorkspaceId) || null
}
