import "client-only"

import { useShallow } from "zustand/react/shallow"

import type { UrlBookmark, ConversationUrlBookmark } from "@/shared/types"
import { uuid } from "@/shared/uuid"
import {
  gcOrphanedAttachment,
  stripSelectionId,
  tombstoneUrlBookmark,
} from "@/client/store/cascade"

import { useStore, useActiveConversation } from "../../use-store"
import type { SliceCreator } from "../types"

/** Frozen empty-array sentinel so the "no active conversation" branch
 *  returns a stable reference under `useShallow`. */
const EMPTY_BOOKMARKS: readonly UrlBookmark[] = Object.freeze([])

/**
 * URL-bookmarks slice — saved web pages. Workspace-library rows
 * (`urlBookmarks`) ticked on per conversation via
 * `Conversation.selectedUrlBookmarkIds`, plus a conversation-private
 * lane (`conversationUrlBookmarks`).
 *
 * `removeUrlBookmark` cascades within its own rows (drops joins +
 * selection ids); `removeConversationUrlBookmark` GCs the underlying
 * bookmark when no live join remains. Both run through the shared `set`.
 */
export interface UrlBookmarksSlice {
  urlBookmarks: UrlBookmark[]
  conversationUrlBookmarks: ConversationUrlBookmark[]

  /** Add a freshly-fetched bookmark to the active workspace. The
   *  caller is responsible for the `/api/url/fetch` round-trip and
   *  passes the extracted fields here. Returns the inserted row. */
  addUrlBookmark: (input: {
    workspaceId: string
    url: string
    title: string
    content: string
    contentTruncated: boolean
    contentHash: string
    description?: string
    faviconUrl?: string
  }) => UrlBookmark
  /** Replace the cached content of a bookmark after a manual refresh.
   *  Bumps `fetchedAt` + `updatedAt` automatically. */
  updateUrlBookmark: (
    bookmarkId: string,
    patch: Partial<
      Pick<
        UrlBookmark,
        | "title"
        | "content"
        | "contentTruncated"
        | "contentHash"
        | "description"
        | "faviconUrl"
      >
    >
  ) => void
  /** Tombstone a bookmark. Drops all joins and selection ids
   *  atomically; metadata stub (url, title, createdAt) remains so
   *  historical message references resolve cleanly. */
  removeUrlBookmark: (bookmarkId: string) => void
  /** Pin a bookmark privately to a conversation. No-op if already
   *  pinned. */
  addConversationUrlBookmark: (conversationId: string, bookmarkId: string) => void
  /** Unpin a private bookmark. GC's the underlying bookmark when no
   *  other live join references it. */
  removeConversationUrlBookmark: (
    conversationId: string,
    bookmarkId: string
  ) => void
  /** Toggle a workspace-library bookmark on/off for the active
   *  conversation (mirrors the file + MCP-resource selection). */
  toggleConversationUrlBookmarkSelection: (bookmarkId: string) => void
}

export const createUrlBookmarksSlice: SliceCreator<UrlBookmarksSlice> = (set) => ({
  urlBookmarks: [],
  conversationUrlBookmarks: [],

  addUrlBookmark: ({
    workspaceId,
    url,
    title,
    content,
    contentTruncated,
    contentHash,
    description,
    faviconUrl,
  }) => {
    const now = new Date()
    const newBookmark: UrlBookmark = {
      id: uuid(),
      workspaceId,
      url,
      title,
      content,
      contentTruncated,
      fetchedAt: now,
      contentHash,
      description,
      faviconUrl,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({ urlBookmarks: [...state.urlBookmarks, newBookmark] }))
    return newBookmark
  },
  updateUrlBookmark: (bookmarkId, patch) =>
    set((state) => ({
      urlBookmarks: state.urlBookmarks.map((b) =>
        b.id === bookmarkId && !b.deletedAt
          ? {
              ...b,
              ...patch,
              fetchedAt: new Date(),
              updatedAt: new Date(),
            }
          : b
      ),
    })),
  removeUrlBookmark: (bookmarkId) =>
    set((state) => ({
      urlBookmarks: state.urlBookmarks.map((b) =>
        b.id === bookmarkId && !b.deletedAt ? tombstoneUrlBookmark(b) : b
      ),
      // Atomic cascade: drop join rows and selection ids that
      // reference the bookmark.
      conversationUrlBookmarks: state.conversationUrlBookmarks.filter(
        (cub) => cub.bookmarkId !== bookmarkId
      ),
      conversations: stripSelectionId(state.conversations, "url_bookmark", bookmarkId),
    })),
  addConversationUrlBookmark: (conversationId, bookmarkId) =>
    set((state) => {
      if (
        state.conversationUrlBookmarks.some(
          (cub) =>
            cub.conversationId === conversationId &&
            cub.bookmarkId === bookmarkId
        )
      ) {
        return state
      }
      const newJoin: ConversationUrlBookmark = {
        id: uuid(),
        conversationId,
        bookmarkId,
        addedAt: new Date(),
      }
      return {
        conversationUrlBookmarks: [...state.conversationUrlBookmarks, newJoin],
      }
    }),
  removeConversationUrlBookmark: (conversationId, bookmarkId) =>
    set((state) => {
      const newJoins = state.conversationUrlBookmarks.filter(
        (cub) =>
          !(
            cub.conversationId === conversationId &&
            cub.bookmarkId === bookmarkId
          )
      )
      const orphanPatch = gcOrphanedAttachment(
        { ...state, conversationUrlBookmarks: newJoins },
        { kind: "url_bookmark", id: bookmarkId }
      )
      return { conversationUrlBookmarks: newJoins, ...orphanPatch }
    }),
  toggleConversationUrlBookmarkSelection: (bookmarkId) =>
    set((state) => {
      const id = state.activeConversationId
      if (!id) return state
      return {
        conversations: state.conversations.map((c) => {
          if (c.id !== id) return c
          const selected = c.selectedUrlBookmarkIds ?? []
          return {
            ...c,
            selectedUrlBookmarkIds: selected.includes(bookmarkId)
              ? selected.filter((x) => x !== bookmarkId)
              : [...selected, bookmarkId],
          }
        }),
      }
    }),
})

/** Live URL bookmarks in the active workspace. Filter runs inside
 *  the Zustand selector so re-renders only fire when the filtered
 *  list actually changes shape. */
export const useWorkspaceUrlBookmarks = (): UrlBookmark[] =>
  useStore(
    useShallow((state) =>
      state.urlBookmarks.filter(
        (b) => b.workspaceId === state.activeWorkspaceId && !b.deletedAt,
      ),
    ),
  )

/** URL bookmarks pinned privately to the active conversation.
 *  Builds a one-shot id→bookmark index so the join is O(joins) not
 *  O(joins × bookmarks). */
export const useConversationPrivateUrlBookmarks = (): UrlBookmark[] =>
  useStore(
    useShallow((state) => {
      if (!state.activeConversationId) return EMPTY_BOOKMARKS as UrlBookmark[]
      const byId = new Map<string, UrlBookmark>()
      for (const b of state.urlBookmarks) byId.set(b.id, b)
      const out: UrlBookmark[] = []
      for (const cub of state.conversationUrlBookmarks) {
        if (cub.conversationId !== state.activeConversationId) continue
        const b = byId.get(cub.bookmarkId)
        if (b && !b.deletedAt) out.push(b)
      }
      return out
    }),
  )

/** Workspace URL bookmarks ticked on for the active conversation. */
export const useConversationSelectedUrlBookmarkIds = (): string[] => {
  const conv = useActiveConversation()
  return conv?.selectedUrlBookmarkIds ?? []
}
