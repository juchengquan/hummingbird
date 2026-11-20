import "client-only"

/**
 * Aborts the in-flight streams of conversations that no longer exist —
 * deleted in this tab, or in another tab (the cross-tab merge lets that
 * delete win over the stream, `store/cross-tab-merge.ts`). Without this
 * the stream keeps appending to a message of a conversation that's gone
 * (and creating artifacts on it). Returns the aborted conversation ids.
 */
export function abortStreamsOfDeletedConversations(
  controllers: Map<string, AbortController>,
  conversations: ReadonlyArray<{ id: string }>
): string[] {
  if (controllers.size === 0) return []
  const live = new Set(conversations.map((c) => c.id))
  const aborted: string[] = []
  for (const [id, controller] of controllers) {
    if (live.has(id)) continue
    controller.abort()
    aborted.push(id)
  }
  return aborted
}
