import "client-only"

import { useShallow } from "zustand/react/shallow"

import type { Note } from "@/shared/types"
import { uuid } from "@/shared/uuid"

import { useStore } from "../../use-store"
import type { SliceCreator } from "../types"

/** Frozen empty-array sentinel so the "no active selection" branches
 *  return a stable reference under `useShallow`. */
const EMPTY_NOTES: readonly Note[] = Object.freeze([])

/**
 * Notes slice — free-form notes & message bookmarks. Scoped to a
 * workspace (and optionally a conversation/message). Notes survive
 * conversation deletion: the conversation-delete cascade in the
 * conversations slice nulls their `conversationId` rather than dropping
 * them, so this slice owns no cross-entity cascade of its own.
 */
export interface NotesSlice {
  notes: Note[]

  createNote: (input: {
    conversationId: string | null
    messageId?: string | null
    body?: string
  }) => Note
  updateNoteBody: (noteId: string, body: string) => void
  deleteNote: (noteId: string) => void
  /** Returns the resulting bookmark note if created, or null if removed. */
  toggleMessageBookmark: (conversationId: string, messageId: string) => Note | null
}

export const createNotesSlice: SliceCreator<NotesSlice> = (set, get) => ({
  notes: [],

  createNote: ({ conversationId, messageId = null, body = "" }) => {
    const conv = conversationId
      ? get().conversations.find((c) => c.id === conversationId)
      : undefined
    const workspaceId = conv?.workspaceId ?? get().activeWorkspaceId
    const now = new Date()
    const newNote: Note = {
      id: uuid(),
      workspaceId,
      conversationId,
      messageId,
      body,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({ notes: [newNote, ...state.notes] }))
    return newNote
  },
  updateNoteBody: (noteId, body) =>
    set((state) => ({
      notes: state.notes.map((n) =>
        n.id === noteId ? { ...n, body, updatedAt: new Date() } : n
      ),
    })),
  deleteNote: (noteId) =>
    set((state) => ({
      notes: state.notes.filter((n) => n.id !== noteId),
    })),
  toggleMessageBookmark: (conversationId, messageId) => {
    const existing = get().notes.find(
      (n) => n.conversationId === conversationId && n.messageId === messageId
    )
    if (existing) {
      set((state) => ({
        notes: state.notes.filter((n) => n.id !== existing.id),
      }))
      return null
    }
    const conv = get().conversations.find((c) => c.id === conversationId)
    const workspaceId = conv?.workspaceId ?? get().activeWorkspaceId
    const now = new Date()
    const newNote: Note = {
      id: uuid(),
      workspaceId,
      conversationId,
      messageId,
      body: "",
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({ notes: [newNote, ...state.notes] }))
    return newNote
  },
})

export const useConversationNotes = () =>
  useStore(
    useShallow((state) => {
      if (!state.activeConversationId) return EMPTY_NOTES as Note[]
      return state.notes.filter(
        (n) => n.conversationId === state.activeConversationId,
      )
    }),
  )

/** Notes visible in the active workspace. Replaces the per-conversation
 *  view in the right rail's Notes tab — notes now survive conversation
 *  deletion and accumulate at the workspace level. */
export const useWorkspaceNotes = () =>
  useStore(
    useShallow((state) => {
      if (!state.activeWorkspaceId) return EMPTY_NOTES as Note[]
      return state.notes.filter(
        (n) => n.workspaceId === state.activeWorkspaceId,
      )
    }),
  )

/** Bookmark note for a specific message in the active conversation,
 *  or null. Single-object return — default Zustand `Object.is` suffices,
 *  so no `useShallow` needed; doing the find inside still ensures the
 *  subscription tracks the found note ref rather than the whole array. */
export const useMessageBookmark = (messageId: string) =>
  useStore(
    (state) =>
      state.notes.find(
        (n) =>
          n.conversationId === state.activeConversationId &&
          n.messageId === messageId,
      ) ?? null,
  )
