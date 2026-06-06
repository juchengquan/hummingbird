import type { Artifact, Conversation, GeneratedImage } from "@/shared/types"

/**
 * Pure helper that flattens a workspace's conversations + artifacts
 * into a single newest-first stream of "library items." Drives the
 * Library panel; lives under `lib/shared/` so it's unit-testable
 * without React or the Zustand store.
 */

export interface ImageItem {
  kind: "image"
  image: GeneratedImage
  conversationId: string
  conversationTitle: string
  messageId: string
  timestamp: Date
}

export interface ArtifactItem {
  kind: "artifact"
  artifact: Artifact
  conversationTitle: string
  timestamp: Date
}

export type LibraryItem = ImageItem | ArtifactItem

/**
 * Produce the library list for `workspaceId`. Newest-first; images and
 * artifacts interleaved by timestamp (the panel groups them visually
 * but the underlying order is one stream).
 *
 * Iteration cost: `O(messages_in_workspace + artifacts_in_workspace)`.
 * Conversation lookup for the artifact-side join is `O(1)` via a Map
 * built once, so the artifact pass doesn't add an N×M factor.
 *
 * Conversations whose `workspaceId !== workspaceId` are skipped without
 * touching their messages. Artifacts whose `workspaceId !== workspaceId`
 * are skipped without resolving their conversation title.
 */
export function collectWorkspaceLibraryItems(
  workspaceId: string,
  conversations: readonly Conversation[],
  artifacts: readonly Artifact[],
): LibraryItem[] {
  const wsConvs = conversations.filter((c) => c.workspaceId === workspaceId)
  if (wsConvs.length === 0) {
    // No conversations → no images either (images live on messages
    // within conversations). Artifacts can still exist if their source
    // conversation was deleted, so the artifact pass still runs.
    return collectArtifactsOnly(workspaceId, artifacts, new Map())
  }

  // Map for O(1) conversation-title lookup when projecting artifacts.
  const titleByConvId = new Map<string, string>()
  for (const c of wsConvs) {
    titleByConvId.set(c.id, c.title || "Untitled")
  }

  const items: LibraryItem[] = []
  for (const conv of wsConvs) {
    const title = titleByConvId.get(conv.id) ?? "Untitled"
    for (const msg of conv.messages) {
      if (!msg.generatedImages || msg.generatedImages.length === 0) continue
      for (const image of msg.generatedImages) {
        items.push({
          kind: "image",
          image,
          conversationId: conv.id,
          conversationTitle: title,
          messageId: msg.id,
          timestamp: new Date(msg.timestamp),
        })
      }
    }
  }
  items.push(...collectArtifactsOnly(workspaceId, artifacts, titleByConvId))
  items.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  return items
}

function collectArtifactsOnly(
  workspaceId: string,
  artifacts: readonly Artifact[],
  titleByConvId: Map<string, string>,
): ArtifactItem[] {
  const out: ArtifactItem[] = []
  for (const a of artifacts) {
    if (a.workspaceId !== workspaceId) continue
    const convTitle =
      a.conversationId !== null
        ? titleByConvId.get(a.conversationId) ?? "Untitled"
        : "Untitled"
    out.push({
      kind: "artifact",
      artifact: a,
      conversationTitle: convTitle,
      timestamp: new Date(a.createdAt),
    })
  }
  return out
}
