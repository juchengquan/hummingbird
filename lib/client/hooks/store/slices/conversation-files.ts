import "client-only"

import { useShallow } from "zustand/react/shallow"

import type { ConversationFile, UploadedFile } from "@/shared/types"
import { uuid } from "@/shared/uuid"
import { gcOrphanedAttachment } from "@/client/store/cascade"

import { useStore, useActiveConversation } from "../../use-store"
import type { SliceCreator } from "../types"

/** Frozen empty-array sentinel so the "no active conversation" branch
 *  returns a stable reference under `useShallow`. */
const EMPTY_FILES: readonly UploadedFile[] = Object.freeze([])

/**
 * Conversation-private file slice — the file-to-conversation join. Sits
 * alongside `resources`: a `fileId` can be in either, both, or neither.
 * Private files are scoped to one conversation and never appear in the
 * workspace library. Also owns the per-conversation selection toggles
 * over the workspace-library `selectedFileIds`.
 */
export interface ConversationFilesSlice {
  conversationFiles: ConversationFile[]

  /** Attach a file privately to a conversation. The file is **not**
   *  added to the workspace library — it lives only inside this chat.
   *  No-op if the join already exists. */
  addConversationFile: (conversationId: string, fileId: string) => void
  /** Detach a private file from a conversation. If this was the last
   *  reference to the underlying `UploadedFile` (no `resources` row and
   *  no other `conversationFiles` row), the file is GC'd. */
  removeConversationFile: (conversationId: string, fileId: string) => void
  /** Toggle a file's attachment to the active conversation (no-op if no active conversation). */
  toggleConversationFileSelection: (fileId: string) => void
  /** Clear all attached files on the active conversation. */
  clearConversationFileSelection: () => void
}

export const createConversationFilesSlice: SliceCreator<ConversationFilesSlice> = (
  set
) => ({
  conversationFiles: [],

  addConversationFile: (conversationId, fileId) =>
    set((state) => {
      // Idempotent: don't add a second join row for the same pair.
      if (
        state.conversationFiles.some(
          (cf) => cf.conversationId === conversationId && cf.fileId === fileId
        )
      ) {
        return state
      }
      const newJoin: ConversationFile = {
        id: uuid(),
        conversationId,
        fileId,
        addedAt: new Date(),
      }
      return {
        conversationFiles: [...state.conversationFiles, newJoin],
      }
    }),
  removeConversationFile: (conversationId, fileId) =>
    set((state) => {
      const newConversationFiles = state.conversationFiles.filter(
        (cf) => !(cf.conversationId === conversationId && cf.fileId === fileId)
      )
      const orphanPatch = gcOrphanedAttachment(
        { ...state, conversationFiles: newConversationFiles },
        { kind: "file", id: fileId }
      )
      return { conversationFiles: newConversationFiles, ...orphanPatch }
    }),
  toggleConversationFileSelection: (fileId) =>
    set((state) => {
      const id = state.activeConversationId
      if (!id) return state
      return {
        conversations: state.conversations.map((c) =>
          c.id === id
            ? {
                ...c,
                selectedFileIds: c.selectedFileIds.includes(fileId)
                  ? c.selectedFileIds.filter((x) => x !== fileId)
                  : [...c.selectedFileIds, fileId],
              }
            : c
        ),
      }
    }),
  clearConversationFileSelection: () =>
    set((state) => {
      const id = state.activeConversationId
      if (!id) return state
      return {
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, selectedFileIds: [] } : c
        ),
      }
    }),
})

/**
 * Files attached privately to the active conversation. These do NOT
 * appear in the workspace library — they're scoped to one chat. Empty
 * when there's no active conversation. Inner-joins against `files[]`
 * so dangling refs are skipped silently.
 */
/** Files pinned privately to the active conversation. Builds an
 *  in-selector id→file Map so the join is O(joins + files) rather
 *  than the prior O(joins × files). */
export const useConversationPrivateFiles = (): UploadedFile[] =>
  useStore(
    useShallow((state) => {
      if (!state.activeConversationId) return EMPTY_FILES as UploadedFile[]
      const byId = new Map<string, UploadedFile>()
      for (const f of state.files) byId.set(f.id, f)
      const out: UploadedFile[] = []
      for (const cf of state.conversationFiles) {
        if (cf.conversationId !== state.activeConversationId) continue
        const f = byId.get(cf.fileId)
        if (f && !f.deletedAt) out.push(f)
      }
      return out
    }),
  )

/**
 * Returns the file IDs the active conversation has attached as context
 * for its next message. Empty array if there's no active conversation.
 */
export const useConversationSelectedFileIds = (): string[] => {
  const conv = useActiveConversation()
  return conv?.selectedFileIds ?? []
}
