"use client"
import "client-only"

/**
 * Pure attachment-collection helper extracted from
 * `components/panels/chat.tsx`. Given the active conversation and the
 * store's `files` + `conversationFiles` slices, returns the unioned
 * (workspace-ticked + conversation-private) list of attached files
 * along with the image files whose data-URLs should ride on the most
 * recent user turn. The data URLs themselves live in IndexedDB since
 * store v32 — resolve them with `getFileImageDataUrls`
 * (`@/client/files/blob-fields`).
 *
 * Pure: takes the store slices as args, no React, no `useStore`. Tested
 * independently in `build-attachments.test.ts`.
 */

import type { Conversation, ConversationFile, UploadedFile } from "@/shared/types"

export interface BuiltAttachments {
  /** The de-duplicated, tombstone-filtered file IDs in send order. */
  attachedFileIds: string[]
  /** The matching `UploadedFile` rows. */
  attachedFiles: UploadedFile[]
  /** Attached image files (vision models) — resolve their data URLs
   *  with `getFileImageDataUrls`. Empty when no images are attached. */
  attachedImageFiles: UploadedFile[]
}

/**
 * Merge the two attachment lanes for a conversation:
 *   - workspace files ticked via `conversation.selectedFileIds`
 *   - conversation-private files from `conversationFiles`
 *
 * De-duped by file id so a file in both lanes is sent once. Tombstoned
 * files (`deletedAt` set) drop out — they still render as "removed"
 * placeholders in message chips via `MessageAttachments`, just not
 * sent upstream.
 *
 * Image attachment policy: images ride on the **most recent user turn
 * only** (re-sending them every turn would explode the token bill and
 * isn't how vision chats are typically structured). This helper just
 * returns the image files; `buildTransmittedMessages` decides where
 * their URLs go.
 */
export function buildAttachments(input: {
  conversation: Conversation | null | undefined
  files: UploadedFile[]
  conversationFiles: ConversationFile[]
}): BuiltAttachments {
  const { conversation, files, conversationFiles } = input
  // Index workspace entities up front so the attachment-collection
  // is O(attached) instead of O(attached × workspace-total).
  const filesById = new Map(files.map((f) => [f.id, f]))

  const workspaceFileIds = conversation?.selectedFileIds ?? []
  const privateFileIds = conversation
    ? conversationFiles
        .filter((cf) => cf.conversationId === conversation.id)
        .map((cf) => cf.fileId)
    : []

  const attachedFileIds = [
    ...new Set([...workspaceFileIds, ...privateFileIds]),
  ]
  const attachedFiles = attachedFileIds
    .map((id) => filesById.get(id))
    .filter((f): f is UploadedFile => !!f && !f.deletedAt)

  const attachedImageFiles = attachedFiles.filter(
    (f) => f.extractedKind === "image"
  )

  return { attachedFileIds, attachedFiles, attachedImageFiles }
}
