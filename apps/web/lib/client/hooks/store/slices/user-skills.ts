import "client-only"

import type { UserSkill } from "@/shared/skills/user-skill-types"
import { uuid } from "@/shared/uuid"

import type { SliceCreator } from "../types"

/**
 * Portable user-skills slice (`docs/PLAN-portable-skills.md`).
 * Workspace-scoped, soft-deleted, persisted locally (no Supabase sync in
 * v1). Enabled skills' bodies are folded into the system prompt by the
 * chat-send pipeline via `withUserSkillInstructions`. Mirrors the agents
 * slice; no slug / activeId (engagement is the `enabled` toggle in v1).
 */
export interface UserSkillsSlice {
  userSkills: UserSkill[]

  createUserSkill: (input: {
    workspaceId: string
    name: string
    description?: string
    whenToUse?: string
    body?: string
    enabled?: boolean
  }) => UserSkill
  updateUserSkill: (
    skillId: string,
    patch: Partial<
      Pick<UserSkill, "name" | "description" | "whenToUse" | "body" | "enabled">
    >
  ) => void
  setUserSkillEnabled: (skillId: string, enabled: boolean) => void
  deleteUserSkill: (skillId: string) => void
  restoreUserSkill: (skillId: string) => void
}

export const createUserSkillsSlice: SliceCreator<UserSkillsSlice> = (set) => ({
  userSkills: [],

  createUserSkill: ({
    workspaceId,
    name,
    description = "",
    whenToUse = "",
    body = "",
    enabled = true,
  }) => {
    const now = new Date()
    const skill: UserSkill = {
      id: uuid(),
      workspaceId,
      name: name.trim(),
      description: description.trim(),
      whenToUse: whenToUse.trim(),
      body,
      enabled,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({ userSkills: [...state.userSkills, skill] }))
    return skill
  },
  updateUserSkill: (skillId, patch) =>
    set((state) => ({
      userSkills: state.userSkills.map((s) => {
        if (s.id !== skillId) return s
        return {
          ...s,
          name: patch.name?.trim() ?? s.name,
          description:
            patch.description !== undefined
              ? patch.description.trim()
              : s.description,
          whenToUse:
            patch.whenToUse !== undefined ? patch.whenToUse.trim() : s.whenToUse,
          body: patch.body !== undefined ? patch.body : s.body,
          enabled: patch.enabled !== undefined ? patch.enabled : s.enabled,
          updatedAt: new Date(),
        }
      }),
    })),
  setUserSkillEnabled: (skillId, enabled) =>
    set((state) => ({
      userSkills: state.userSkills.map((s) =>
        s.id === skillId ? { ...s, enabled, updatedAt: new Date() } : s
      ),
    })),
  deleteUserSkill: (skillId) =>
    set((state) => ({
      userSkills: state.userSkills.map((s) =>
        s.id === skillId
          ? { ...s, deletedAt: new Date(), updatedAt: new Date() }
          : s
      ),
    })),
  restoreUserSkill: (skillId) =>
    set((state) => ({
      userSkills: state.userSkills.map((s) =>
        s.id === skillId
          ? { ...s, deletedAt: undefined, updatedAt: new Date() }
          : s
      ),
    })),
})
