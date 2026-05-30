import "client-only"

import type { Prompt } from "@/shared/types"
import { uuid } from "@/shared/uuid"
import { parseTemplate } from "@/shared/prompts/expand"

import { useStore } from "../../use-store"
import { defaultSlug, ensureUniquePromptSlug } from "../../store-helpers"
import type { SliceCreator } from "../types"

/**
 * Prompts slice — user-scoped saved templates (workspace-scoped rows).
 * Listed in the left sidebar's Prompts group; click-to-insert drops the
 * expanded template into the chat input via `pendingChatInput`. See
 * docs/_done/PLAN-prompt-library.md. No cross-entity cascades.
 */
export interface PromptsSlice {
  prompts: Prompt[]

  // Slug is auto-derived from `name` on create via `defaultSlug()`; the
  // create action accepts optional `slug` for cases (import,
  // duplicate-with-rename) where the caller wants control.
  createPrompt: (input: {
    workspaceId: string
    name: string
    template: string
    slug?: string
  }) => Prompt
  updatePrompt: (
    promptId: string,
    patch: Partial<Pick<Prompt, "name" | "slug" | "template">>
  ) => void
  /** Soft-delete — sets `deletedAt`. The Phase 2 sync layer reads the
   *  marker; the UI filters it out everywhere. */
  deletePrompt: (promptId: string) => void
  /** Clears the soft-delete marker. Restored prompts re-appear in the
   *  sidebar list. Currently no Undo UI for this in v1 — exposed
   *  programmatically for future surfaces. */
  restorePrompt: (promptId: string) => void
}

export const createPromptsSlice: SliceCreator<PromptsSlice> = (set, get) => ({
  prompts: [],

  createPrompt: ({ workspaceId, name, template, slug }) => {
    const now = new Date()
    const baseSlug = slug?.trim() || defaultSlug(name)
    const uniqueSlug = ensureUniquePromptSlug(
      baseSlug,
      get().prompts.filter((p) => p.workspaceId === workspaceId)
    )
    const prompt: Prompt = {
      id: uuid(),
      workspaceId,
      name: name.trim(),
      slug: uniqueSlug,
      template,
      variables: parseTemplate(template).variables,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({ prompts: [...state.prompts, prompt] }))
    return prompt
  },
  updatePrompt: (promptId, patch) =>
    set((state) => ({
      prompts: state.prompts.map((p) => {
        if (p.id !== promptId) return p
        const nextName = patch.name?.trim() ?? p.name
        const nextTemplate = patch.template ?? p.template
        // Slug rules:
        //   - Explicit slug in patch wins (after slug-collision check).
        //   - Otherwise keep the existing slug stable across renames.
        //     (Auto-rederiving from name would break muscle memory once
        //     Phase 3 slash triggers ship.)
        let nextSlug = p.slug
        if (patch.slug !== undefined) {
          const requested = patch.slug.trim() || defaultSlug(nextName)
          nextSlug = ensureUniquePromptSlug(requested, state.prompts, p.id)
        }
        return {
          ...p,
          name: nextName,
          slug: nextSlug,
          template: nextTemplate,
          variables: parseTemplate(nextTemplate).variables,
          updatedAt: new Date(),
        }
      }),
    })),
  deletePrompt: (promptId) =>
    set((state) => ({
      prompts: state.prompts.map((p) =>
        p.id === promptId
          ? { ...p, deletedAt: new Date(), updatedAt: new Date() }
          : p
      ),
    })),
  restorePrompt: (promptId) =>
    set((state) => ({
      prompts: state.prompts.map((p) =>
        p.id === promptId
          ? { ...p, deletedAt: undefined, updatedAt: new Date() }
          : p
      ),
    })),
})

/** Non-deleted prompts scoped to the active workspace, sorted by
 *  updatedAt desc. */
export const useWorkspacePrompts = (): Prompt[] => {
  const prompts = useStore((state) => state.prompts)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  if (!activeWorkspaceId) return []
  return prompts
    .filter((p) => p.workspaceId === activeWorkspaceId && !p.deletedAt)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}
