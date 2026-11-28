import "client-only"

import { useShallow } from "zustand/react/shallow"

import type { Resource, UploadedFile } from "@/shared/types"
import { uuid } from "@/shared/uuid"
import { gcOrphanedAttachment, stripSelectionId } from "@/client/store/cascade"

import { useStore } from "../../use-store"
import type { SliceCreator } from "../types"

/**
 * Resources slice — the file-to-workspace association (workspace
 * library). `removeResource` strips the file from every conversation's
 * selection and GCs the underlying `UploadedFile` when no live join
 * remains, via the shared cascade helper.
 */
export interface ResourcesSlice {
  resources: Resource[]

  addResource: (workspaceId: string, fileId: string) => void
  removeResource: (resourceId: string) => void
}

export const createResourcesSlice: SliceCreator<ResourcesSlice> = (set) => ({
  resources: [],

  addResource: (workspaceId, fileId) => {
    const newResource: Resource = {
      id: uuid(),
      workspaceId,
      fileId,
      addedAt: new Date(),
    }
    set((state) => ({
      resources: [...state.resources, newResource],
    }))
  },
  removeResource: (resourceId) =>
    set((state) => {
      const target = state.resources.find((r) => r.id === resourceId)
      const newResources = state.resources.filter((r) => r.id !== resourceId)
      if (!target) return { resources: newResources }
      // Strip the fileId from every conversation's selection — once the
      // resource is gone the workspace-library tick no longer makes sense.
      const newConversations = stripSelectionId(state.conversations, "file", target.fileId)
      const orphanPatch = gcOrphanedAttachment(
        { ...state, resources: newResources, conversations: newConversations },
        { kind: "file", id: target.fileId }
      )
      return { resources: newResources, conversations: newConversations, ...orphanPatch }
    }),
})

/** Files attached to the active workspace's library. Builds an
 *  in-selector id→file Map so the join is O(resources + files) rather
 *  than the prior O(resources × files). */
export const useWorkspaceResources = (): UploadedFile[] =>
  useStore(
    useShallow((state) => {
      const byId = new Map<string, UploadedFile>()
      for (const f of state.files) byId.set(f.id, f)
      const out: UploadedFile[] = []
      for (const r of state.resources) {
        if (r.workspaceId !== state.activeWorkspaceId) continue
        const f = byId.get(r.fileId)
        if (f && !f.deletedAt) out.push(f)
      }
      return out
    }),
  )
