"use client"
import "client-only"

/**
 * Resolve which conversation a chat `send` should route its reply onto.
 *
 * An explicit `targetConversationId` wins over the React-subscribed
 * `activeConversationId`. The caller passes a target when it has *just*
 * created a conversation (e.g. a non-destructive edit/regenerate fork)
 * in the same event tick: `forkConversation` already set
 * `activeConversationId = fork.id` in the Zustand store, but the send
 * pipeline's React-subscribed `activeConversationId` / `conversations`
 * closures haven't re-rendered yet, so without an explicit target the
 * streamed reply would land on the SOURCE conversation. With no target,
 * the subscribed `activeConversationId` is used unchanged — preserving
 * the tab-switch-mid-stream protection that relies on it.
 *
 * Pulled into a leaf module so the routing rule is unit-testable without
 * dragging in the send pipeline's full import graph.
 */
export function resolveSendTargetConversationId(
  options: { targetConversationId?: string } | undefined,
  activeConversationId: string | null
): string | null {
  return options?.targetConversationId ?? activeConversationId
}
