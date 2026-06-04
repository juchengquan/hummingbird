import "client-only"

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

export const useWorkspaceResources = () => {
  const resources = useStore((state) => state.resources)
  const files = useStore((state) => state.files)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  const workspaceResources = resources.filter((r) => r.workspaceId === activeWorkspaceId)
  return workspaceResources
    .map((r) => files.find((f) => f.id === r.fileId))
    .filter((f): f is UploadedFile => !!f && !f.deletedAt)
}
