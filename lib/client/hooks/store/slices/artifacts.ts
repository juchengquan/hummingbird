import "client-only"

import { useShallow } from "zustand/react/shallow"

import type { Artifact, ArtifactKind } from "@/shared/types"
import { uuid } from "@/shared/uuid"
import { placeRelatedNode } from "@/shared/canvas/placement"

import { useStore, useActiveConversation } from "../../use-store"
import type { SliceCreator } from "../types"

/**
 * Artifacts slice — assistant-generated content captured by the user.
 * Workspace-scoped (with a conversation/message backref). Owns the
 * `editorReloadToken` bump used to force the editor panel to reload.
 *
 * `createArtifact` also writes the source workspace's canvas state
 * (auto-place beside the originating message) through the shared `set` —
 * a cross-slice write into the workspace row, not a cascade.
 */
export interface ArtifactsSlice {
  artifacts: Artifact[]
  /** Bumped to force the editor to reload its content (e.g. on "Send to editor"). */
  editorReloadToken: number

  createArtifact: (input: {
    conversationId: string
    messageId?: string | null
    kind: ArtifactKind
    language?: string | null
    title?: string
    content: string
    storagePath?: string | null
  }) => Artifact
  deleteArtifact: (artifactId: string) => void
  togglePinArtifact: (artifactId: string) => void
  updateArtifactTitle: (artifactId: string, title: string) => void
  /** Replace an artifact's `content` (e.g. an in-place table edit). Like
   *  updateArtifactTitle, this is a plain field set; `content` already
   *  syncs via diffArtifacts. */
  updateArtifactContent: (artifactId: string, content: string) => void
  /** Replace a single artifact's `storagePath` — used by the lazy
   *  signed-URL re-sign path so the fresh URL persists + syncs. No-op if
   *  the id is missing or the value is unchanged. */
  updateArtifactStoragePath: (artifactId: string, storagePath: string) => void
  requestEditorReload: () => void
  /** Toggle an artifact's selection for the active conversation
   *  (mirrors the file + URL-bookmark selection pattern). */
  toggleConversationArtifactSelection: (artifactId: string) => void
}

export const createArtifactsSlice: SliceCreator<ArtifactsSlice> = (set, get) => ({
  artifacts: [],
  editorReloadToken: 0,

  createArtifact: ({ conversationId, messageId = null, kind, language = null, title, content, storagePath = null }) => {
    const fallbackTitle =
      title ?? content.split("\n")[0].slice(0, 60).trim() ?? "Untitled"
    const conv = get().conversations.find((c) => c.id === conversationId)
    const workspaceId = conv?.workspaceId ?? get().activeWorkspaceId
    const newArtifact: Artifact = {
      id: uuid(),
      workspaceId,
      conversationId,
      messageId,
      kind,
      language,
      title: fallbackTitle || "Untitled",
      content,
      storagePath,
      pinned: false,
      createdAt: new Date(),
    }
    set((state) => ({ artifacts: [newArtifact, ...state.artifacts] }))
    // Canvas Phase 4 — auto-place. If this workspace's canvas is in
    // use AND the source message is already a node on it, drop the
    // new artifact beside that message with a connecting edge. Gated
    // on the message being present so we never force a canvas on a
    // user who isn't using one, and never add an orphan with no
    // anchor. Artifacts are only created from chat view (never while
    // the canvas panel is mounted), so the panel's mount-seed picks
    // this up — no live-reconcile needed. See lib/shared/canvas/placement.
    if (messageId) {
      const ws = get().workspaces.find((w) => w.id === workspaceId)
      const canvas = ws?.canvasState
      if (
        canvas &&
        canvas.nodes.length > 0 &&
        canvas.nodes.some((n) => n.id === messageId)
      ) {
        const nextCanvas = placeRelatedNode(
          canvas,
          messageId,
          { id: newArtifact.id, kind: "artifact" },
          { connect: true }
        )
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === workspaceId
              ? { ...w, canvasState: nextCanvas, updatedAt: new Date() }
              : w
          ),
        }))
      }
    }
    return newArtifact
  },
  deleteArtifact: (artifactId) =>
    set((state) => {
      // Atomic cascade: drop selection ids that reference the artifact
      // so a deleted artifact doesn't linger as a tick in any
      // conversation. Mirrors the file/MCP/url-bookmark pattern, but
      // only allocates a new `conversations` array when at least one
      // row actually carries this id — keeps the ref stable for
      // selectors that subscribe to `state.conversations` whole.
      const touchesAnyConv = state.conversations.some((c) =>
        c.selectedArtifactIds?.includes(artifactId)
      )
      return {
        artifacts: state.artifacts.filter((a) => a.id !== artifactId),
        ...(touchesAnyConv
          ? {
              conversations: state.conversations.map((c) => {
                const sel = c.selectedArtifactIds
                if (!sel || !sel.includes(artifactId)) return c
                const next = sel.filter((id) => id !== artifactId)
                return {
                  ...c,
                  selectedArtifactIds: next.length > 0 ? next : undefined,
                }
              }),
            }
          : {}),
      }
    }),
  togglePinArtifact: (artifactId) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === artifactId ? { ...a, pinned: !a.pinned } : a
      ),
    })),
  updateArtifactTitle: (artifactId, title) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === artifactId ? { ...a, title } : a
      ),
    })),
  updateArtifactContent: (artifactId, content) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === artifactId ? { ...a, content } : a,
      ),
    })),
  updateArtifactStoragePath: (artifactId, storagePath) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === artifactId && a.storagePath !== storagePath
          ? { ...a, storagePath }
          : a,
      ),
    })),
  requestEditorReload: () =>
    set((state) => ({ editorReloadToken: state.editorReloadToken + 1 })),
  toggleConversationArtifactSelection: (artifactId) =>
    set((state) => {
      const id = state.activeConversationId
      if (!id) return state
      return {
        conversations: state.conversations.map((c) => {
          if (c.id !== id) return c
          const selected = c.selectedArtifactIds ?? []
          return {
            ...c,
            selectedArtifactIds: selected.includes(artifactId)
              ? selected.filter((x) => x !== artifactId)
              : [...selected, artifactId],
          }
        }),
      }
    }),
})

/** Sort comparator shared by both artifact selectors — pinned-first,
 *  then by `createdAt` desc. Stable, pure, dependency-free. */
function compareArtifacts(a: Artifact, b: Artifact): number {
  if (a.pinned && !b.pinned) return -1
  if (!a.pinned && b.pinned) return 1
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
}

/** Artifacts visible in the active conversation. Filter + sort run
 *  inside the Zustand selector under `useShallow` so consumers only
 *  re-render when the filtered+sorted list actually changes shape —
 *  adding an artifact to a different conversation is a no-op for
 *  every consumer of this hook. */
export const useConversationArtifacts = () =>
  useStore(
    useShallow((state) => {
      if (!state.activeConversationId) return EMPTY_ARTIFACTS
      return state.artifacts
        .filter((a) => a.conversationId === state.activeConversationId)
        .sort(compareArtifacts)
    }),
  )

/** Artifacts visible in the active workspace. Same shape as
 *  `useConversationArtifacts` but scoped one level up. */
export const useWorkspaceArtifacts = () =>
  useStore(
    useShallow((state) => {
      if (!state.activeWorkspaceId) return EMPTY_ARTIFACTS
      return state.artifacts
        .filter((a) => a.workspaceId === state.activeWorkspaceId)
        .sort(compareArtifacts)
    }),
  )

/** Frozen empty-array sentinel so the "no active selection" branch
 *  returns a stable reference (otherwise every render would yield a
 *  fresh `[]` and break the shallow-equality check in useShallow). */
const EMPTY_ARTIFACTS: readonly Artifact[] = Object.freeze([])

/** Workspace artifacts ticked on for the active conversation. */
export const useConversationSelectedArtifactIds = (): string[] => {
  const conv = useActiveConversation()
  return conv?.selectedArtifactIds ?? []
}
