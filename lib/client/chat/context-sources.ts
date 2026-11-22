"use client"
import "client-only"

/**
 * The MCP resources and URL bookmarks a conversation has attached — the
 * other two source kinds next to files (`build-attachments.ts`). Both the
 * Next chat body (`use-chat-send`'s `attachmentsForRequest`) and a turn on
 * runs (`lib/client/runs/attachments.ts`) send exactly these.
 *
 * Each kind has two lanes, as files do: workspace items ticked on the
 * conversation (`selectedMcpResourceIds` / `selectedUrlBookmarkIds`) and
 * conversation-private ones (the `conversation*` join rows). De-duped by
 * id, in that order; unknown ids and tombstones drop out.
 *
 * Pure except `hasSignedInSession`.
 */

import type {
  Conversation,
  ConversationMcpResource,
  ConversationUrlBookmark,
  McpResource,
  UrlBookmark,
} from "@/shared/types"

function pick<T extends { id: string; deletedAt?: Date }>(
  ids: readonly string[],
  rows: readonly T[],
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: T[] = []
  for (const id of new Set(ids)) {
    const row = byId.get(id)
    if (row && !row.deletedAt) out.push(row)
  }
  return out
}

export function attachedMcpResources(
  conversation: Conversation | null | undefined,
  slices: {
    mcpResources: readonly McpResource[]
    conversationMcpResources: readonly ConversationMcpResource[]
  },
): McpResource[] {
  if (!conversation) return []
  const ids = [
    ...(conversation.selectedMcpResourceIds ?? []),
    ...slices.conversationMcpResources
      .filter((r) => r.conversationId === conversation.id)
      .map((r) => r.resourceId),
  ]
  return pick(ids, slices.mcpResources)
}

export function attachedUrlBookmarks(
  conversation: Conversation | null | undefined,
  slices: {
    urlBookmarks: readonly UrlBookmark[]
    conversationUrlBookmarks: readonly ConversationUrlBookmark[]
  },
): UrlBookmark[] {
  if (!conversation) return []
  const ids = [
    ...(conversation.selectedUrlBookmarkIds ?? []),
    ...slices.conversationUrlBookmarks
      .filter((b) => b.conversationId === conversation.id)
      .map((b) => b.bookmarkId),
  ]
  return pick(ids, slices.urlBookmarks)
}

/**
 * Whether a Supabase user is signed in on this browser — then the user's
 * files are synced `files` rows the backend can read and search by id
 * (Q44 / Q47). False when signed out, Supabase is unconfigured, or the
 * lookup fails.
 */
export async function hasSignedInSession(): Promise<boolean> {
  try {
    const { getSupabaseBrowserClient } = await import("@/client/supabase/client")
    const supa = getSupabaseBrowserClient()
    if (!supa) return false
    const { data } = await supa.auth.getSession()
    return Boolean(data.session?.user)
  } catch {
    return false
  }
}
