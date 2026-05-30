import "client-only"

import type {
  McpServer,
  McpResource,
  McpResourceBinding,
  ConversationMcpResource,
  McpCapabilities,
  McpCredentialMode,
} from "@/shared/types"
import { uuid } from "@/shared/uuid"
import { gcOrphanedAttachment, tombstoneMcpResource } from "@/client/store/cascade"

import { useStore, useActiveConversation } from "../../use-store"
import { tombstoneMcpServer } from "../../store-helpers"
import type { SliceCreator } from "../types"

/**
 * MCP slice — workspace-scoped server bindings + the resources they
 * expose. Same lane model as files: workspace library
 * (`mcpResourceBindings`) + conversation-private
 * (`conversationMcpResources`).
 *
 * `removeMcpServer` owns a deep cascade (tombstone server → tombstone its
 * resources → drop bindings + conversation joins + selection ids).
 * Binding/join removals GC the underlying resource when no live ref
 * remains. The workspace-delete cascade (workspaces slice) prunes a
 * workspace's MCP rows separately.
 */
export interface McpSlice {
  mcpServers: McpServer[]
  mcpResources: McpResource[]
  mcpResourceBindings: McpResourceBinding[]
  conversationMcpResources: ConversationMcpResource[]

  /** Create a new MCP server config in the active workspace. Returns
   *  the inserted record. Discovery (`capabilities`) happens out-of-
   *  band via the proxy route. */
  addMcpServer: (input: {
    workspaceId: string
    name: string
    url: string
    credentialMode: McpCredentialMode
    credentialFingerprint?: string
    enabled?: boolean
  }) => McpServer
  /** Patch arbitrary fields on a server. Bumps `updatedAt`. */
  updateMcpServer: (
    serverId: string,
    patch: Partial<
      Pick<McpServer, "name" | "url" | "enabled" | "credentialMode" | "credentialFingerprint">
    >
  ) => void
  /** Replace the cached `capabilities` blob — called after a successful
   *  discovery round-trip. Also stamps `capabilitiesFetchedAt`. */
  setMcpServerCapabilities: (serverId: string, capabilities: McpCapabilities) => void
  setMcpServerEnabled: (serverId: string, enabled: boolean) => void
  /** Tombstone a server. Drops all dependent rows (resources, bindings,
   *  conversation joins) atomically; metadata stub remains so historic
   *  references resolve cleanly. */
  removeMcpServer: (serverId: string) => void

  /** Upsert a server-discovered resource into the cache. Idempotent on
   *  (serverId, uri). */
  upsertMcpResource: (input: {
    workspaceId: string
    serverId: string
    uri: string
    name: string
    description?: string
    mimeType?: string
  }) => McpResource
  /** Add a workspace-library binding for an MCP resource. No-op if the
   *  binding already exists. */
  addMcpResourceBinding: (workspaceId: string, resourceId: string) => void
  /** Drop a workspace-library binding. Strips the resource id from every
   *  conversation's `selectedMcpResourceIds`. If no other join references
   *  the underlying `McpResource`, it's GC'd (tombstoned). */
  removeMcpResourceBinding: (bindingId: string) => void
  /** Pin an MCP resource privately to a conversation. No-op if it's
   *  already pinned. */
  addConversationMcpResource: (conversationId: string, resourceId: string) => void
  /** Unpin a private MCP resource. GC's the underlying `McpResource`
   *  if it has no remaining live references. */
  removeConversationMcpResource: (conversationId: string, resourceId: string) => void
  /** Toggle a workspace-library MCP resource on/off for the active
   *  conversation (mirrors `toggleConversationFileSelection`). */
  toggleConversationMcpResourceSelection: (resourceId: string) => void
}

export const createMcpSlice: SliceCreator<McpSlice> = (set, get) => ({
  mcpServers: [],
  mcpResources: [],
  mcpResourceBindings: [],
  conversationMcpResources: [],

  addMcpServer: ({ workspaceId, name, url, credentialMode, credentialFingerprint, enabled = true }) => {
    const now = new Date()
    const newServer: McpServer = {
      id: uuid(),
      workspaceId,
      name,
      url,
      transport: "http",
      credentialMode,
      credentialFingerprint,
      enabled,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({ mcpServers: [...state.mcpServers, newServer] }))
    return newServer
  },
  updateMcpServer: (serverId, patch) =>
    set((state) => ({
      mcpServers: state.mcpServers.map((s) =>
        s.id === serverId && !s.deletedAt
          ? { ...s, ...patch, updatedAt: new Date() }
          : s
      ),
    })),
  setMcpServerCapabilities: (serverId, capabilities) =>
    set((state) => ({
      mcpServers: state.mcpServers.map((s) =>
        s.id === serverId && !s.deletedAt
          ? {
              ...s,
              capabilities,
              capabilitiesFetchedAt: new Date(),
              updatedAt: new Date(),
            }
          : s
      ),
    })),
  setMcpServerEnabled: (serverId, enabled) =>
    set((state) => ({
      mcpServers: state.mcpServers.map((s) =>
        s.id === serverId && !s.deletedAt
          ? { ...s, enabled, updatedAt: new Date() }
          : s
      ),
    })),
  removeMcpServer: (serverId) =>
    set((state) => {
      // Atomic cascade: tombstone the server, drop every dependent
      // row (resources, bindings, conversation joins, selection ids).
      // Resources cascade-tombstone too — their addressing depends on
      // the server existing.
      const droppedResourceIds = new Set(
        state.mcpResources
          .filter((r) => r.serverId === serverId && !r.deletedAt)
          .map((r) => r.id)
      )
      return {
        mcpServers: state.mcpServers.map((s) =>
          s.id === serverId && !s.deletedAt ? tombstoneMcpServer(s) : s
        ),
        mcpResources: state.mcpResources.map((r) =>
          droppedResourceIds.has(r.id) ? tombstoneMcpResource(r) : r
        ),
        mcpResourceBindings: state.mcpResourceBindings.filter(
          (b) => !droppedResourceIds.has(b.resourceId)
        ),
        conversationMcpResources: state.conversationMcpResources.filter(
          (cmr) => !droppedResourceIds.has(cmr.resourceId)
        ),
        conversations: state.conversations.map((c) => {
          const selected = c.selectedMcpResourceIds ?? []
          const filtered = selected.filter((id) => !droppedResourceIds.has(id))
          return filtered.length === selected.length
            ? c
            : { ...c, selectedMcpResourceIds: filtered }
        }),
      }
    }),

  upsertMcpResource: ({ workspaceId, serverId, uri, name, description, mimeType }) => {
    // Idempotent on (serverId, uri): re-discovery shouldn't create
    // duplicate cache rows. Update name/description in place when
    // they change.
    const existing = get().mcpResources.find(
      (r) => r.serverId === serverId && r.uri === uri && !r.deletedAt
    )
    if (existing) {
      set((state) => ({
        mcpResources: state.mcpResources.map((r) =>
          r.id === existing.id ? { ...r, name, description, mimeType } : r
        ),
      }))
      return { ...existing, name, description, mimeType }
    }
    const newResource: McpResource = {
      id: uuid(),
      workspaceId,
      serverId,
      uri,
      name,
      description,
      mimeType,
      addedAt: new Date(),
    }
    set((state) => ({ mcpResources: [...state.mcpResources, newResource] }))
    return newResource
  },
  addMcpResourceBinding: (workspaceId, resourceId) =>
    set((state) => {
      if (
        state.mcpResourceBindings.some(
          (b) => b.workspaceId === workspaceId && b.resourceId === resourceId
        )
      ) {
        return state
      }
      const newBinding: McpResourceBinding = {
        id: uuid(),
        workspaceId,
        resourceId,
        addedAt: new Date(),
      }
      return {
        mcpResourceBindings: [...state.mcpResourceBindings, newBinding],
      }
    }),
  removeMcpResourceBinding: (bindingId) =>
    set((state) => {
      const target = state.mcpResourceBindings.find((b) => b.id === bindingId)
      if (!target) return state
      const newBindings = state.mcpResourceBindings.filter((b) => b.id !== bindingId)
      // Strip the resource id from every conversation's selection.
      const newConversations = state.conversations.map((c) => {
        const selected = c.selectedMcpResourceIds ?? []
        if (!selected.includes(target.resourceId)) return c
        return {
          ...c,
          selectedMcpResourceIds: selected.filter((id) => id !== target.resourceId),
        }
      })
      const orphanPatch = gcOrphanedAttachment(
        {
          ...state,
          mcpResourceBindings: newBindings,
          conversations: newConversations,
        },
        { kind: "mcp_resource", id: target.resourceId }
      )
      return {
        mcpResourceBindings: newBindings,
        conversations: newConversations,
        ...orphanPatch,
      }
    }),
  addConversationMcpResource: (conversationId, resourceId) =>
    set((state) => {
      if (
        state.conversationMcpResources.some(
          (cmr) => cmr.conversationId === conversationId && cmr.resourceId === resourceId
        )
      ) {
        return state
      }
      const newJoin: ConversationMcpResource = {
        id: uuid(),
        conversationId,
        resourceId,
        addedAt: new Date(),
      }
      return {
        conversationMcpResources: [...state.conversationMcpResources, newJoin],
      }
    }),
  removeConversationMcpResource: (conversationId, resourceId) =>
    set((state) => {
      const newJoins = state.conversationMcpResources.filter(
        (cmr) => !(cmr.conversationId === conversationId && cmr.resourceId === resourceId)
      )
      const orphanPatch = gcOrphanedAttachment(
        { ...state, conversationMcpResources: newJoins },
        { kind: "mcp_resource", id: resourceId }
      )
      return { conversationMcpResources: newJoins, ...orphanPatch }
    }),
  toggleConversationMcpResourceSelection: (resourceId) =>
    set((state) => {
      const id = state.activeConversationId
      if (!id) return state
      return {
        conversations: state.conversations.map((c) => {
          if (c.id !== id) return c
          const selected = c.selectedMcpResourceIds ?? []
          return {
            ...c,
            selectedMcpResourceIds: selected.includes(resourceId)
              ? selected.filter((x) => x !== resourceId)
              : [...selected, resourceId],
          }
        }),
      }
    }),
})

/** MCP servers belonging to the active workspace (live, non-tombstoned). */
export const useWorkspaceMcpServers = (): McpServer[] => {
  const mcpServers = useStore((state) => state.mcpServers)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return mcpServers.filter(
    (s) => s.workspaceId === activeWorkspaceId && !s.deletedAt
  )
}

/** MCP resources bound to the active workspace's library. */
export const useWorkspaceMcpResources = (): McpResource[] => {
  const mcpResourceBindings = useStore((state) => state.mcpResourceBindings)
  const mcpResources = useStore((state) => state.mcpResources)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return mcpResourceBindings
    .filter((b) => b.workspaceId === activeWorkspaceId)
    .map((b) => mcpResources.find((r) => r.id === b.resourceId))
    .filter((r): r is McpResource => !!r && !r.deletedAt)
}

/** MCP resources pinned privately to the active conversation. */
export const useConversationPrivateMcpResources = (): McpResource[] => {
  const conversationMcpResources = useStore(
    (state) => state.conversationMcpResources
  )
  const mcpResources = useStore((state) => state.mcpResources)
  const activeConversationId = useStore((state) => state.activeConversationId)
  if (!activeConversationId) return []
  return conversationMcpResources
    .filter((cmr) => cmr.conversationId === activeConversationId)
    .map((cmr) => mcpResources.find((r) => r.id === cmr.resourceId))
    .filter((r): r is McpResource => !!r && !r.deletedAt)
}

/** Workspace MCP resources ticked on for the active conversation. */
export const useConversationSelectedMcpResourceIds = (): string[] => {
  const conv = useActiveConversation()
  return conv?.selectedMcpResourceIds ?? []
}
