import "client-only"

import type { Document } from "@/shared/types"
import { uuid } from "@/shared/uuid"

import { useStore } from "../../use-store"
import type { SliceCreator } from "../types"

/**
 * Documents slice — rich-text docs inside a workspace. A workspace owns
 * N documents; `activeDocumentId` tracks which one the editor panel is
 * showing. The workspace-delete cascade and `setActiveWorkspace` (both
 * in the workspaces slice) re-point `activeDocumentId` through the
 * shared `set`; this slice owns the document CRUD.
 */
export interface DocumentsSlice {
  documents: Document[]
  activeDocumentId: string | null

  createDocument: (workspaceId: string, title?: string) => Document
  deleteDocument: (documentId: string) => void
  renameDocument: (documentId: string, title: string) => void
  setDocumentContent: (documentId: string, content: string) => void
  /** Append a markdown fragment to a document with a horizontal-rule
   *  separator. Used by "Send to editor" sites so prior work isn't
   *  overwritten. */
  appendToDocument: (documentId: string, fragment: string) => void
  setActiveDocument: (documentId: string | null) => void
  /** Convenience for "Send to editor" callers: appends to the active
   *  document, or creates one in the active workspace if none is set. */
  appendToActiveDocumentOrCreate: (fragment: string) => void
}

export const createDocumentsSlice: SliceCreator<DocumentsSlice> = (set, get) => ({
  documents: [],
  activeDocumentId: null,

  createDocument: (workspaceId, title) => {
    const now = new Date()
    // Default title: "Untitled" + a disambiguator scoped to the
    // workspace (so the doc list doesn't show three "Untitled"s).
    const existingCount = get().documents.filter(
      (d) => d.workspaceId === workspaceId
    ).length
    const defaultTitle =
      existingCount === 0 ? "Untitled" : `Untitled ${existingCount + 1}`
    const newDoc: Document = {
      id: uuid(),
      workspaceId,
      title: title?.trim() || defaultTitle,
      content: "",
      position: existingCount,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      documents: [newDoc, ...state.documents],
    }))
    return newDoc
  },
  deleteDocument: (documentId) =>
    set((state) => {
      const newDocuments = state.documents.filter((d) => d.id !== documentId)
      // If the active doc was the one deleted, swap to the next most-
      // recently-updated doc in the same workspace (or null).
      let newActiveDocumentId = state.activeDocumentId
      if (state.activeDocumentId === documentId) {
        const deleted = state.documents.find((d) => d.id === documentId)
        const wsId = deleted?.workspaceId
        const fallback = newDocuments
          .filter((d) => d.workspaceId === wsId)
          .sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          )[0]
        newActiveDocumentId = fallback?.id ?? null
      }
      return {
        documents: newDocuments,
        activeDocumentId: newActiveDocumentId,
      }
    }),
  renameDocument: (documentId, title) =>
    set((state) => {
      const trimmed = title.trim()
      if (!trimmed) return state
      return {
        documents: state.documents.map((d) =>
          d.id === documentId ? { ...d, title: trimmed, updatedAt: new Date() } : d
        ),
      }
    }),
  setDocumentContent: (documentId, content) =>
    set((state) => ({
      documents: state.documents.map((d) =>
        d.id === documentId ? { ...d, content, updatedAt: new Date() } : d
      ),
    })),
  appendToDocument: (documentId, fragment) =>
    set((state) => ({
      documents: state.documents.map((d) => {
        if (d.id !== documentId) return d
        const trimmedFragment = fragment.trim()
        if (!trimmedFragment) return d
        const existing = (d.content ?? "").trim()
        const next = existing
          ? `${existing}\n\n---\n\n${trimmedFragment}\n`
          : `${trimmedFragment}\n`
        return { ...d, content: next, updatedAt: new Date() }
      }),
    })),
  setActiveDocument: (documentId) => set({ activeDocumentId: documentId }),
  appendToActiveDocumentOrCreate: (fragment) => {
    const trimmed = fragment.trim()
    if (!trimmed) return
    const state = get()
    const targetId =
      state.activeDocumentId ??
      (state.activeWorkspaceId
        ? get().createDocument(state.activeWorkspaceId).id
        : null)
    if (!targetId) return
    if (!state.activeDocumentId) {
      // The doc we just created — make it active so the editor opens
      // to it after the upcoming reload.
      set({ activeDocumentId: targetId })
    }
    get().appendToDocument(targetId, trimmed)
  },
})

/** Documents in the active workspace, sorted by position (asc) and then
 *  by updatedAt (desc) as a tiebreaker. Switching workspaces re-runs the
 *  derivation through the `activeWorkspaceId` dependency. */
export const useWorkspaceDocuments = (): Document[] => {
  const documents = useStore((state) => state.documents)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  if (!activeWorkspaceId) return []
  return documents
    .filter((d) => d.workspaceId === activeWorkspaceId)
    .sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
}

/** Current open document, or null when the workspace has none yet. */
export const useActiveDocument = (): Document | null => {
  const documents = useStore((state) => state.documents)
  const activeDocumentId = useStore((state) => state.activeDocumentId)
  if (!activeDocumentId) return null
  return documents.find((d) => d.id === activeDocumentId) ?? null
}

/** Convenience: just the active doc's `content`. Empty string when none. */
export const useActiveDocumentContent = (): string => {
  const doc = useActiveDocument()
  return doc?.content ?? ""
}
