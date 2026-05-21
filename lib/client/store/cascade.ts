import "client-only"

import { deleteBlob as deleteLocalBlob } from "@/client/files/local-store"
import type { AttachmentKind } from "@/shared/attachments"
import type {
  Conversation,
  ConversationFile,
  ConversationMcpResource,
  ConversationUrlBookmark,
  McpResource,
  McpResourceBinding,
  Resource,
  UploadedFile,
  UrlBookmark,
} from "@/shared/types"

/**
 * Cascade helpers for source attachments.
 *
 * Three lane pairs (files + MCP resources + URL bookmarks) used to
 * have three near-identical "drop join → check refs → maybe tombstone"
 * blocks scattered across `use-store.ts`. This module consolidates
 * the ref-counting + tombstone logic into two pure helpers; callers
 * compose the resulting deltas inside a single Zustand `set()`.
 *
 * See `docs/PLAN-attachments-polymorphism.md` for the design.
 */

export type AttachmentRef = { kind: AttachmentKind; id: string }

/**
 * The subset of `AppState` these helpers read. Kept narrow on
 * purpose — the real `AppState` is large and importing it here
 * would create a circular dependency with `use-store.ts`. Each
 * helper accepts the relevant slices and returns a typed patch.
 */
export interface CascadeStateView {
  files: UploadedFile[]
  resources: Resource[]
  conversationFiles: ConversationFile[]
  mcpResources: McpResource[]
  mcpResourceBindings: McpResourceBinding[]
  conversationMcpResources: ConversationMcpResource[]
  urlBookmarks: UrlBookmark[]
  conversationUrlBookmarks: ConversationUrlBookmark[]
  conversations: Conversation[]
}

/**
 * True iff any live reference to the attachment remains across both
 * lanes and all conversations.
 *
 * "Live" means: a workspace-library join row, a conversation-private
 * join row, or the attachment's id ticked in some conversation's
 * `selected*Ids` array. The check ignores tombstoned entities — once
 * an entity is tombstoned its join rows have already been dropped
 * atomically, so a tombstone with live joins shouldn't happen in
 * healthy state; if it does the defensive prune in
 * `onRehydrateStorage` catches it.
 */
export function hasLiveReference(
  state: CascadeStateView,
  ref: AttachmentRef
): boolean {
  switch (ref.kind) {
    case "file":
      return (
        state.resources.some((r) => r.fileId === ref.id) ||
        state.conversationFiles.some((cf) => cf.fileId === ref.id) ||
        state.conversations.some((c) => c.selectedFileIds.includes(ref.id))
      )
    case "mcp_resource":
      return (
        state.mcpResourceBindings.some((b) => b.resourceId === ref.id) ||
        state.conversationMcpResources.some((cmr) => cmr.resourceId === ref.id) ||
        state.conversations.some((c) =>
          (c.selectedMcpResourceIds ?? []).includes(ref.id)
        )
      )
    case "url_bookmark":
      return (
        state.conversationUrlBookmarks.some((cub) => cub.bookmarkId === ref.id) ||
        state.conversations.some((c) =>
          (c.selectedUrlBookmarkIds ?? []).includes(ref.id)
        )
      )
  }
}

/**
 * Patch shape returned by `gcOrphanedAttachment`. Callers spread
 * this into the partial they pass to `set()`. Empty object when the
 * attachment still has live refs (no-op).
 */
export interface CascadePatch {
  files?: UploadedFile[]
  mcpResources?: McpResource[]
  urlBookmarks?: UrlBookmark[]
}

/**
 * If the attachment has no live references, tombstone its underlying
 * entity. Fires `deleteLocalBlob` for files as a side effect
 * (best-effort IDB cleanup).
 *
 * Caller composes the returned patch inside a single `set()`:
 *
 *   set((state) => {
 *     const newJoins = state.conversationFiles.filter(…)
 *     const post = { ...state, conversationFiles: newJoins }
 *     const orphan = gcOrphanedAttachment(post, { kind: 'file', id: fileId })
 *     return { conversationFiles: newJoins, ...orphan }
 *   })
 *
 * The "compose against post-drop state" pattern matters: the helper
 * needs to see the state *after* the join was removed, otherwise
 * the ref-count check returns the wrong answer.
 */
export function gcOrphanedAttachment(
  state: CascadeStateView,
  ref: AttachmentRef
): CascadePatch {
  if (hasLiveReference(state, ref)) return {}

  switch (ref.kind) {
    case "file": {
      void deleteLocalBlob(ref.id)
      return {
        files: state.files.map((f) =>
          f.id === ref.id && !f.deletedAt ? tombstoneFile(f) : f
        ),
      }
    }
    case "mcp_resource":
      return {
        mcpResources: state.mcpResources.map((r) =>
          r.id === ref.id && !r.deletedAt ? tombstoneMcpResource(r) : r
        ),
      }
    case "url_bookmark":
      return {
        urlBookmarks: state.urlBookmarks.map((b) =>
          b.id === ref.id && !b.deletedAt ? tombstoneUrlBookmark(b) : b
        ),
      }
  }
}

/**
 * Bulk variant: de-dup refs internally by `(kind, id)` and fold each
 * GC patch onto the running state so the next ref sees a fresh
 * `hasLiveReference` view. Use this for `deleteConversation` /
 * `deleteWorkspace`-style bulk cascades — calling
 * `gcOrphanedAttachment` in a loop at the call site requires the
 * same dedup + state-folding boilerplate.
 */
export function gcOrphanedAttachments(
  state: CascadeStateView,
  refs: AttachmentRef[]
): CascadePatch {
  let view: CascadeStateView = state
  let patch: CascadePatch = {}
  const seen = new Set<string>()
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const next = gcOrphanedAttachment(view, ref)
    if (next.files) view = { ...view, files: next.files }
    if (next.mcpResources) view = { ...view, mcpResources: next.mcpResources }
    if (next.urlBookmarks) view = { ...view, urlBookmarks: next.urlBookmarks }
    patch = { ...patch, ...next }
  }
  return patch
}

// ---------------------------------------------------------------------------
// Per-kind tombstone helpers
//
// These stay separate because each kind keeps a different set of
// identifying fields (file: id/name/size/type/uploadedAt; MCP:
// id/workspaceId/serverId/uri/name; URL: id/workspaceId/url/title/
// content_hash/...). Folding into a single helper would lose the
// per-shape type safety the GC depends on.
// ---------------------------------------------------------------------------

export function tombstoneFile(file: UploadedFile): UploadedFile {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    uploadedAt: file.uploadedAt,
    deletedAt: new Date(),
  }
}

export function tombstoneMcpResource(resource: McpResource): McpResource {
  return {
    id: resource.id,
    workspaceId: resource.workspaceId,
    serverId: resource.serverId,
    uri: resource.uri,
    name: resource.name,
    addedAt: resource.addedAt,
    deletedAt: new Date(),
  }
}

export function tombstoneUrlBookmark(bookmark: UrlBookmark): UrlBookmark {
  return {
    id: bookmark.id,
    workspaceId: bookmark.workspaceId,
    url: bookmark.url,
    title: bookmark.title,
    content: "",
    contentTruncated: false,
    fetchedAt: bookmark.fetchedAt,
    contentHash: bookmark.contentHash,
    createdAt: bookmark.createdAt,
    updatedAt: bookmark.updatedAt,
    deletedAt: new Date(),
  }
}

// ---------------------------------------------------------------------------
// Fork-time helper: collect the conversation-private joins that
// should follow a fork.
//
// Used by `forkConversation` to inherit the source conversation's
// private file / MCP-resource / URL-bookmark attachments onto the
// fork. The three `selected*Ids` arrays on the conversation itself
// (workspace-ticked attachments) are copied directly on the new
// Conversation row — that lives in the createConversation-shaped
// block, not here.
// ---------------------------------------------------------------------------

export interface ForkedJoins {
  conversationFiles: ConversationFile[]
  conversationMcpResources: ConversationMcpResource[]
  conversationUrlBookmarks: ConversationUrlBookmark[]
}

export function forkConversationJoins(
  state: Pick<
    CascadeStateView,
    "conversationFiles" | "conversationMcpResources" | "conversationUrlBookmarks"
  >,
  sourceId: string,
  forkId: string,
  newId: () => string
): ForkedJoins {
  return {
    conversationFiles: state.conversationFiles
      .filter((cf) => cf.conversationId === sourceId)
      .map((cf) => ({
        id: newId(),
        conversationId: forkId,
        fileId: cf.fileId,
        addedAt: new Date(),
      })),
    conversationMcpResources: state.conversationMcpResources
      .filter((cmr) => cmr.conversationId === sourceId)
      .map((cmr) => ({
        id: newId(),
        conversationId: forkId,
        resourceId: cmr.resourceId,
        addedAt: new Date(),
      })),
    conversationUrlBookmarks: state.conversationUrlBookmarks
      .filter((cub) => cub.conversationId === sourceId)
      .map((cub) => ({
        id: newId(),
        conversationId: forkId,
        bookmarkId: cub.bookmarkId,
        addedAt: new Date(),
      })),
  }
}
