import "client-only"

import type { Agent } from "@/shared/types"
import { uuid } from "@/shared/uuid"

import { defaultSlug, ensureUniqueAgentSlug } from "../../store-helpers"
import type { SliceCreator } from "../types"

/**
 * Agents / personas slice (`PLAN-custom-agents.md`) — workspace-scoped
 * saved bundles of { name, system prompt, model, allowed skills, allowed
 * MCP servers } invoked via `/<slug>` or pinned per conversation. Slug
 * auto-derived from `name`; `activeAgentId` is the per-conversation pin.
 * `deleteAgent` unpins itself if active — no cross-entity cascade.
 */
export interface AgentsSlice {
  agents: Agent[]
  /** Currently pinned persona for the active conversation. Cleared by
   *  the user or on conversation switch. Null when no persona is
   *  pinned. */
  activeAgentId: string | null

  createAgent: (input: {
    workspaceId: string
    name: string
    systemPrompt?: string
    modelId?: string
    allowedSkillIds?: string[]
    allowedMcpServerIds?: string[]
    slug?: string
    icon?: string
  }) => Agent
  updateAgent: (
    agentId: string,
    patch: Partial<
      Pick<
        Agent,
        | "name"
        | "slug"
        | "systemPrompt"
        | "modelId"
        | "allowedSkillIds"
        | "allowedMcpServerIds"
        | "icon"
        | "pinned"
      >
    >
  ) => void
  deleteAgent: (agentId: string) => void
  restoreAgent: (agentId: string) => void
  /** Pin a persona to the active conversation. Pass null to clear. */
  setActiveAgent: (agentId: string | null) => void
}

export const createAgentsSlice: SliceCreator<AgentsSlice> = (set, get) => ({
  agents: [],
  activeAgentId: null,

  createAgent: ({
    workspaceId,
    name,
    systemPrompt = "",
    modelId,
    allowedSkillIds = [],
    allowedMcpServerIds = [],
    slug,
    icon,
  }) => {
    const now = new Date()
    const baseSlug = slug?.trim() || defaultSlug(name)
    const uniqueSlug = ensureUniqueAgentSlug(
      baseSlug,
      get().agents.filter((a) => a.workspaceId === workspaceId)
    )
    const agent: Agent = {
      id: uuid(),
      workspaceId,
      name: name.trim(),
      slug: uniqueSlug,
      systemPrompt,
      allowedSkillIds: [...allowedSkillIds],
      allowedMcpServerIds: [...allowedMcpServerIds],
      createdAt: now,
      updatedAt: now,
      ...(modelId ? { modelId } : {}),
      ...(icon ? { icon } : {}),
    }
    set((state) => ({ agents: [...state.agents, agent] }))
    return agent
  },
  updateAgent: (agentId, patch) =>
    set((state) => ({
      agents: state.agents.map((a) => {
        if (a.id !== agentId) return a
        const nextName = patch.name?.trim() ?? a.name
        let nextSlug = a.slug
        if (patch.slug !== undefined) {
          const requested = patch.slug.trim() || defaultSlug(nextName)
          nextSlug = ensureUniqueAgentSlug(
            requested,
            state.agents.filter((x) => x.workspaceId === a.workspaceId),
            a.id
          )
        }
        return {
          ...a,
          name: nextName,
          slug: nextSlug,
          systemPrompt: patch.systemPrompt ?? a.systemPrompt,
          modelId: patch.modelId !== undefined ? patch.modelId : a.modelId,
          allowedSkillIds:
            patch.allowedSkillIds !== undefined
              ? [...patch.allowedSkillIds]
              : a.allowedSkillIds,
          allowedMcpServerIds:
            patch.allowedMcpServerIds !== undefined
              ? [...patch.allowedMcpServerIds]
              : a.allowedMcpServerIds,
          icon: patch.icon !== undefined ? patch.icon : a.icon,
          pinned: patch.pinned !== undefined ? patch.pinned : a.pinned,
          updatedAt: new Date(),
        }
      }),
    })),
  deleteAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId
          ? { ...a, deletedAt: new Date(), updatedAt: new Date() }
          : a
      ),
      // If the deleted persona was active, unpin it.
      activeAgentId:
        state.activeAgentId === agentId ? null : state.activeAgentId,
    })),
  restoreAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId
          ? { ...a, deletedAt: undefined, updatedAt: new Date() }
          : a
      ),
    })),
  setActiveAgent: (agentId) => set({ activeAgentId: agentId }),
})
