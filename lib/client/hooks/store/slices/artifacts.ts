import "client-only"

import type { Artifact, ArtifactKind } from "@/shared/types"
import { uuid } from "@/shared/uuid"
import { placeRelatedNode } from "@/shared/canvas/placement"

import { useStore } from "../../use-store"
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
  requestEditorReload: () => void
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
    set((state) => ({
      artifacts: state.artifacts.filter((a) => a.id !== artifactId),
    })),
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
  requestEditorReload: () =>
    set((state) => ({ editorReloadToken: state.editorReloadToken + 1 })),
})

export const useConversationArtifacts = () => {
  const artifacts = useStore((state) => state.artifacts)
  const activeConversationId = useStore((state) => state.activeConversationId)
  if (!activeConversationId) return [] as Artifact[]
  return artifacts
    .filter((a) => a.conversationId === activeConversationId)
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
}

/** Artifacts visible in the active workspace. Same shape as
 *  `useConversationArtifacts` but scoped one level up. */
export const useWorkspaceArtifacts = () => {
  const artifacts = useStore((state) => state.artifacts)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  if (!activeWorkspaceId) return [] as Artifact[]
  return artifacts
    .filter((a) => a.workspaceId === activeWorkspaceId)
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
}
