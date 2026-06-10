import "client-only"

import { DEFAULT_CHAT_MODEL } from "@/shared/models"
import type { ReasoningEffort } from "@/shared/reasoning-effort"

import type { SliceCreator } from "../types"

/**
 * Chat runtime slice — the ephemeral compose/stream state for the chat
 * panel. Most of these don't persist (see `partializeState`): `chatModel`
 * and `chatReasoningEffort` are the exceptions and are persisted from the
 * slice's own initial values via the persist key list. Streaming + typing
 * + the remix reference are per-session.
 *
 * Cross-slice note: `chatModel` / `sessionModelOverridden` are also
 * written by the workspace slice (`setActiveWorkspace`,
 * `setWorkspaceDefaultModel`) through the shared `set`, which is why the
 * factory is typed against the full `StoreState`.
 */
export interface ChatSlice {
  /** Conversation ids currently mid-stream — populated by chat.tsx
   *  when it starts a send, cleared on stream end (or abort/error).
   *  Per-conversation so switching to another chat while one is
   *  streaming doesn't blanket-disable input everywhere; see
   *  `useIsConversationTyping(id)` for the derived per-conversation
   *  flag. Not persisted: streaming state is ephemeral. */
  typingConversationIds: string[]
  streamingContent: string
  chatModel: string
  /** Reasoning-effort tier for the next turn, for models that support a
   *  thinking-budget / reasoning_effort knob. `null` = provider default
   *  (nothing sent on the wire). Persisted like `chatModel`. Only sent
   *  when the active model supports it (see `modelSupportsReasoningEffort`). */
  chatReasoningEffort: ReasoningEffort | null
  /**
   * Pending image-to-image reference for the next user message. Set by
   * the "Remix" action on a `GeneratedImagesGallery` tile; cleared on
   * send or on explicit dismiss. Lives only at the runtime layer — not
   * persisted (and intentionally not synced) because it's an in-flight
   * compose-time hint, not a property of any saved message.
   *
   * The URL must be publicly fetchable for the Minimax server to load
   * it (signed Supabase Storage URLs qualify; `data:` URLs do not, so
   * Remix is gated on a non-data URL upstream).
   */
  pendingReferenceImage: {
    url: string
    /** Optional source prompt — used in the chip caption so the user
     *  knows which image they're remixing. */
    sourcePrompt?: string
  } | null
  /**
   * True when the user has touched the chat-input model picker since
   * the current workspace was activated. Suppresses the workspace's
   * `defaultModel` from re-applying on every render. Resets when the
   * active workspace changes. Not persisted — this is a per-session
   * intent flag.
   */
  sessionModelOverridden: boolean

  /** Mark a conversation as "typing" (loading dots above the
   *  message list). Idempotent — passing `true` twice for the same
   *  id is a no-op. */
  setConversationTyping: (conversationId: string, typing: boolean) => void
  /** Set the pending I2I reference for the next user message. Pass
   *  `null` to clear. */
  setPendingReferenceImage: (
    value: { url: string; sourcePrompt?: string } | null
  ) => void
  setStreamingContent: (content: string) => void
  setChatModel: (model: string) => void
  /** Set the reasoning-effort tier for the next turn. `null` clears it
   *  back to the provider default. */
  setChatReasoningEffort: (effort: ReasoningEffort | null) => void
}

export const createChatSlice: SliceCreator<ChatSlice> = (set) => ({
  typingConversationIds: [],
  streamingContent: "",
  chatModel: DEFAULT_CHAT_MODEL,
  chatReasoningEffort: null,
  sessionModelOverridden: false,
  pendingReferenceImage: null,

  setConversationTyping: (conversationId, typing) =>
    set((state) => {
      const has = state.typingConversationIds.includes(conversationId)
      if (typing && has) return {}
      if (!typing && !has) return {}
      return {
        typingConversationIds: typing
          ? [...state.typingConversationIds, conversationId]
          : state.typingConversationIds.filter((id) => id !== conversationId),
      }
    }),
  setPendingReferenceImage: (value) => set({ pendingReferenceImage: value }),
  setStreamingContent: (content) => set({ streamingContent: content }),
  setChatModel: (model) => set({ chatModel: model, sessionModelOverridden: true }),
  setChatReasoningEffort: (effort) => set({ chatReasoningEffort: effort }),
})
