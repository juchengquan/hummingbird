import "client-only"

import { useShallow } from "zustand/react/shallow"

import type { Conversation, Message } from "@/shared/types"
import { placeRelatedNode } from "@/shared/canvas/placement"
import { uuid } from "@/shared/uuid"
import {
  cloneAttachmentSelections,
  forkConversationJoins,
  gcOrphanedAttachments,
  type AttachmentRef,
} from "@/client/store/cascade"

import { useStore } from "../../use-store"
import {
  mergeFileSearchConfig,
  mergeImageGenConfig,
  mergeWebFetchConfig,
  mergeWebSearchConfig,
} from "../../store-helpers"
import { DEFAULT_WORKSPACE_ID } from "./workspaces"
import type { SliceCreator, StoreState } from "../types"

export const getDefaultConversations = (): Conversation[] => {
  const baseTime = new Date("2024-01-01T12:00:00Z").getTime()
  return [
    {
      id: "demo-1",
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: "Welcome",
      // Empty by design — the chat panel renders <EmptyChatWelcome> when
      // there are no messages, with feature bullets and suggestion chips.
      // Leaving stale pretend-messages here makes the app feel like a
      // demo someone forgot to wipe before shipping.
      messages: [],
      createdAt: new Date(baseTime - 120000),
      updatedAt: new Date(baseTime),
      pinned: true,
      systemPrompt: "",
      selectedFileIds: [],
      fileRetrievalModes: {},
    },
  ]
}

/**
 * Conversations slice — the conversation rows + the active-conversation
 * pointer. Owns `forkConversation` (deep-copies messages, re-ids them,
 * inherits the source's private joins) and `deleteConversation` (drops
 * the conversation's three private-join lanes, GCs orphaned attachments,
 * nulls notes/artifacts backrefs, drops session pins). Per-message
 * edits live in the messages slice; the workspace-delete cascade
 * (workspaces slice) prunes a workspace's conversations.
 */
export interface ConversationsSlice {
  conversations: Conversation[]
  activeConversationId: string | null

  createConversation: (workspaceId?: string) => Conversation
  /**
   * Branch a conversation at a specific message. Returns a new conversation
   * that contains a copy of every message up to and including `untilMessageId`,
   * inherits the source's workspace + selected files + document content +
   * skill prefs, and is set as active. Messages get fresh ids so the two
   * threads can diverge independently.
   */
  forkConversation: (conversationId: string, untilMessageId: string) => Conversation | null
  deleteConversation: (conversationId: string) => void
  renameConversation: (conversationId: string, title: string) => void
  /** Per-thread system-prompt tier — the slot between workspace voice
   *  and per-turn persona documented in `lib/shared/agents/resolve.ts`.
   *  See `docs/PLAN-conversation-system-prompt.md`. */
  setConversationSystemPrompt: (conversationId: string, prompt: string) => void
  /** Per-conversation memory bypass. When true, this chat neither injects
   *  remembered facts nor extracts new ones. See Slice 2 (trust & lifecycle). */
  setConversationMemoryOff: (conversationId: string, value: boolean) => void
  /** Set the per-attached-file retrieval mode. `mode === null` clears
   *  the override (back to default inline). No-op when the
   *  conversation isn't found. */
  setConversationFileRetrievalMode: (
    conversationId: string,
    fileId: string,
    mode: "rag" | null,
  ) => void
  /** Set a conversation skill override. `null` clears the entry (falls back to workspace default). */
  setConversationSkillPref: (conversationId: string, skillId: string, value: boolean | null) => void
  /** Patch the per-conversation `webSearch` config override (same shape
   *  and semantics as `patchWorkspaceWebSearchConfig`). */
  patchConversationWebSearchConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/web-search-config").WebSearchConfig> | null
  ) => void
  /** Patch the per-conversation `webFetch` config override (same shape
   *  and semantics as `patchWorkspaceWebFetchConfig`). */
  patchConversationWebFetchConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/web-fetch-config").WebFetchConfig> | null
  ) => void
  /** Patch the per-conversation `imageGen` config override. */
  patchConversationImageGenConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/image-gen-config").ImageGenConfig> | null
  ) => void
  /** Patch the per-conversation `searchFiles` config override (same shape
   *  and semantics as `patchWorkspaceFileSearchConfig`). */
  patchConversationFileSearchConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/file-search-config").FileSearchConfig> | null
  ) => void
  togglePin: (conversationId: string) => void
  setActiveConversation: (conversationId: string | null) => void
}

export const createConversationsSlice: SliceCreator<ConversationsSlice> = (
  set,
  get
) => ({
  conversations: getDefaultConversations().map((c) => ({
    ...c,
    pinned: c.pinned ?? false,
    selectedFileIds: c.selectedFileIds ?? [],
  })),
  activeConversationId: "demo-1",

  createConversation: (workspaceId) => {
    const activeWorkspaceId = workspaceId || get().activeWorkspaceId
    const newConversation: Conversation = {
      id: uuid(),
      workspaceId: activeWorkspaceId,
      title: `New Chat ${get().conversations.filter((c) => c.workspaceId === activeWorkspaceId).length + 1}`,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      pinned: false,
      // Empty by default — no inheritance from workspace; the
      // conversation prompt is opt-in additive. See
      // `docs/PLAN-conversation-system-prompt.md` §UI surface.
      systemPrompt: "",
      selectedFileIds: [],
      fileRetrievalModes: {},
    }
    set((state) => ({
      conversations: [newConversation, ...state.conversations],
      activeConversationId: newConversation.id,
    }))
    return newConversation
  },
  forkConversation: (conversationId, untilMessageId) => {
    const source = get().conversations.find((c) => c.id === conversationId)
    if (!source) return null
    const idx = source.messages.findIndex((m) => m.id === untilMessageId)
    if (idx === -1) return null
    const slice = source.messages.slice(0, idx + 1)
    // Re-id messages so edits to either branch don't bleed across.
    // Keep timestamps + content + reasoning + attachments intact so
    // the fork reads as a faithful copy of the past.
    const copiedMessages: Message[] = slice.map((m) => ({
      ...m,
      id: uuid(),
    }))
    const fork: Conversation = {
      id: uuid(),
      workspaceId: source.workspaceId,
      title: `${source.title} (branch)`,
      messages: copiedMessages,
      createdAt: new Date(),
      updatedAt: new Date(),
      pinned: false,
      // Fork carries the thread instructions forward — branching
      // is "continue this same chat from a different point," not
      // "start over with the same files."
      systemPrompt: source.systemPrompt,
      ...cloneAttachmentSelections(source),
      skillPrefs: source.skillPrefs ? { ...source.skillPrefs } : undefined,
      parentId: source.id,
      forkedFromMessageId: untilMessageId,
    }
    set((state) => {
      // Inherit the source's conversation-private joins onto the
      // fork. Single helper covers all three lanes; the underlying
      // entities (files / MCP resources / URL bookmarks) are
      // shared via their existing ids.
      const inherited = forkConversationJoins(state, source.id, fork.id, uuid)
      // Flowchat canvas — auto-place a "conversation" node beside the
      // source-message node when the workspace canvas is in use AND
      // the source message is already a node on it. Mirrors the
      // artifact auto-place block (`artifacts.ts` createArtifact).
      // No edge stored here — fork edges are *derived* at render time
      // from `parentId` + `forkedFromMessageId` (see
      // `buildDerivedForkEdges` / commit 3 of PLAN-flowchat-canvas).
      // Gated on the source-message node being present so we never
      // force a canvas on a user who isn't using one.
      let workspaces = state.workspaces
      const sourceWorkspace = state.workspaces.find(
        (w) => w.id === source.workspaceId,
      )
      const sourceCanvas = sourceWorkspace?.canvasState
      if (
        sourceCanvas &&
        sourceCanvas.nodes.length > 0 &&
        sourceCanvas.nodes.some((n) => n.id === untilMessageId)
      ) {
        const nextCanvas = placeRelatedNode(
          sourceCanvas,
          untilMessageId,
          { id: fork.id, kind: "conversation" },
        )
        if (nextCanvas !== sourceCanvas) {
          workspaces = state.workspaces.map((w) =>
            w.id === source.workspaceId
              ? { ...w, canvasState: nextCanvas, updatedAt: new Date() }
              : w,
          )
        }
      }
      return {
        conversations: [fork, ...state.conversations],
        conversationFiles: [...state.conversationFiles, ...inherited.conversationFiles],
        conversationMcpResources: [
          ...state.conversationMcpResources,
          ...inherited.conversationMcpResources,
        ],
        conversationUrlBookmarks: [
          ...state.conversationUrlBookmarks,
          ...inherited.conversationUrlBookmarks,
        ],
        ...(workspaces !== state.workspaces ? { workspaces } : {}),
        activeConversationId: fork.id,
      }
    })
    return fork
  },
  deleteConversation: (conversationId) =>
    set((state) => {
      const newConversations = state.conversations.filter(
        (c) => c.id !== conversationId
      )
      // Drop every conversation-private join for this conversation
      // across all three lanes. Pre-collect the (kind, id) refs
      // that were orphaned so we can GC them after the join arrays
      // shrink.
      const droppedFileRefs: AttachmentRef[] = state.conversationFiles
        .filter((cf) => cf.conversationId === conversationId)
        .map((cf) => ({ kind: "file" as const, id: cf.fileId }))
      const droppedMcpRefs: AttachmentRef[] = state.conversationMcpResources
        .filter((cmr) => cmr.conversationId === conversationId)
        .map((cmr) => ({ kind: "mcp_resource" as const, id: cmr.resourceId }))
      const droppedUrlRefs: AttachmentRef[] = state.conversationUrlBookmarks
        .filter((cub) => cub.conversationId === conversationId)
        .map((cub) => ({ kind: "url_bookmark" as const, id: cub.bookmarkId }))

      const remainingFileJoins = state.conversationFiles.filter(
        (cf) => cf.conversationId !== conversationId
      )
      const remainingMcpJoins = state.conversationMcpResources.filter(
        (cmr) => cmr.conversationId !== conversationId
      )
      const remainingUrlJoins = state.conversationUrlBookmarks.filter(
        (cub) => cub.conversationId !== conversationId
      )

      // Notes/artifacts are workspace-scoped, but bookmarks (notes with
      // messageId !== null) anchor to a specific message that no longer
      // exists once the conversation is gone — drop those. Free-form
      // notes and all artifacts are orphaned (conversationId → null) so
      // they remain visible at the workspace level.
      const newNotes = state.notes
        .filter(
          (n) => !(n.conversationId === conversationId && n.messageId !== null)
        )
        .map((n) =>
          n.conversationId === conversationId ? { ...n, conversationId: null } : n
        )
      const newArtifacts = state.artifacts.map((a) =>
        a.conversationId === conversationId ? { ...a, conversationId: null } : a
      )
      // Pins are session-only and conversation-scoped — drop them
      // when the conversation goes away so we don't keep dangling
      // references that would never render again.
      const newPins = state.pinnedExplanations.filter(
        (p) => p.conversationId !== conversationId
      )

      // GC each orphaned attachment against the post-drop state.
      // De-dup refs (a workspace file referenced by multiple
      // conversation joins shouldn't get tombstoned twice).
      const patch: Partial<StoreState> = {
        conversations: newConversations,
        conversationFiles: remainingFileJoins,
        conversationMcpResources: remainingMcpJoins,
        conversationUrlBookmarks: remainingUrlJoins,
        notes: newNotes,
        artifacts: newArtifacts,
        pinnedExplanations: newPins,
        activeConversationId:
          state.activeConversationId === conversationId
            ? newConversations[0]?.id || null
            : state.activeConversationId,
      }
      return {
        ...patch,
        ...gcOrphanedAttachments({ ...state, ...patch }, [
          ...droppedFileRefs,
          ...droppedMcpRefs,
          ...droppedUrlRefs,
        ]),
      }
    }),
  renameConversation: (conversationId, title) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, title, updatedAt: new Date() } : c
      ),
    })),
  setConversationSystemPrompt: (conversationId, prompt) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, systemPrompt: prompt, updatedAt: new Date() }
          : c
      ),
    })),
  setConversationMemoryOff: (conversationId, value) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, memoryOff: value, updatedAt: new Date() }
          : c
      ),
    })),
  setConversationFileRetrievalMode: (conversationId, fileId, mode) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== conversationId) return c
        // Clone the modes map; `null` removes the entry, "rag" sets it.
        // Setting to default ("inline") is equivalent to `null` —
        // there's no value in persisting an explicit inline override
        // since absence already means inline.
        const next = { ...(c.fileRetrievalModes ?? {}) }
        if (mode === null) delete next[fileId]
        else next[fileId] = mode
        return { ...c, fileRetrievalModes: next, updatedAt: new Date() }
      }),
    })),
  setConversationSkillPref: (conversationId, skillId, value) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== conversationId) return c
        const current = c.skillPrefs ?? {}
        const next: Record<string, boolean> = { ...current }
        if (value === null) delete next[skillId]
        else next[skillId] = value
        return { ...c, skillPrefs: next, updatedAt: new Date() }
      }),
    })),
  patchConversationWebSearchConfig: (conversationId, patch) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== conversationId) return c
        if (patch === null) {
          const { webSearchConfig: _drop, ...rest } = c
          void _drop
          return { ...rest, updatedAt: new Date() }
        }
        const merged = mergeWebSearchConfig(c.webSearchConfig, patch)
        return { ...c, webSearchConfig: merged, updatedAt: new Date() }
      }),
    })),
  patchConversationWebFetchConfig: (conversationId, patch) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== conversationId) return c
        if (patch === null) {
          const { webFetchConfig: _drop, ...rest } = c
          void _drop
          return { ...rest, updatedAt: new Date() }
        }
        const merged = mergeWebFetchConfig(c.webFetchConfig, patch)
        return { ...c, webFetchConfig: merged, updatedAt: new Date() }
      }),
    })),
  patchConversationImageGenConfig: (conversationId, patch) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== conversationId) return c
        if (patch === null) {
          const { imageGenConfig: _drop, ...rest } = c
          void _drop
          return { ...rest, updatedAt: new Date() }
        }
        const merged = mergeImageGenConfig(c.imageGenConfig, patch)
        return { ...c, imageGenConfig: merged, updatedAt: new Date() }
      }),
    })),
  patchConversationFileSearchConfig: (conversationId, patch) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== conversationId) return c
        if (patch === null) {
          const { fileSearchConfig: _drop, ...rest } = c
          void _drop
          return { ...rest, updatedAt: new Date() }
        }
        const merged = mergeFileSearchConfig(c.fileSearchConfig, patch)
        return { ...c, fileSearchConfig: merged, updatedAt: new Date() }
      }),
    })),
  togglePin: (conversationId) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, pinned: !c.pinned } : c
      ),
    })),
  setActiveConversation: (conversationId) =>
    set({ activeConversationId: conversationId }),
})

/** The active conversation, or null when no id is set OR the id no
 *  longer resolves (e.g. cleared by a cascade). The `.find` runs
 *  inside the Zustand selector so the subscription tracks the found
 *  object, not the whole `conversations` array — unrelated mutations
 *  (typing on another conv, new message on a sibling) don't re-render
 *  consumers of `useActiveConversation()`. */
export const useActiveConversation = () =>
  useStore(
    (state) =>
      state.conversations.find((c) => c.id === state.activeConversationId) ??
      null,
  )

/** True iff the given conversation is currently mid-stream. `null`
 *  conversation id always returns false. Cheap O(n) lookup over the
 *  typing-ids array which is realistically always 0–few items long. */
export const useIsConversationTyping = (conversationId: string | null): boolean => {
  return useStore((state) =>
    conversationId !== null && state.typingConversationIds.includes(conversationId)
  )
}

/** Conversations belonging to the active workspace. Filter runs
 *  inside the selector under `useShallow` so unrelated changes (a new
 *  conversation in another workspace, a message arriving on any conv)
 *  don't re-render the sidebar. */
export const useWorkspaceConversations = () =>
  useStore(
    useShallow((state) =>
      state.conversations.filter((c) => c.workspaceId === state.activeWorkspaceId),
    ),
  )
