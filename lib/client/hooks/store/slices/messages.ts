import "client-only"

import type {
  Message,
  MessageError,
  ToolCallRecord,
  GeneratedImage,
} from "@/shared/types"
import { uuid } from "@/shared/uuid"
import { buildCompressedMessages } from "@/shared/compression"
import { mark as perfMark, count as perfCount } from "@/client/perf-chat-stream"

import type { SliceCreator } from "../types"

/**
 * Messages slice — per-message mutators that operate on the owning
 * conversation's `messages[]` (the conversations slice owns the
 * conversation rows themselves).
 *
 * INVARIANT: every mutator addresses a message by id and finds the
 * owning conversation by scanning every conversation's `messages`
 * array. None of them rely on `activeConversationId`. This is deliberate
 * so two conversations streaming in parallel land their chunks correctly
 * even when the user switches tabs mid-stream. Don't reintroduce an
 * `activeConversationId` filter inside these mutators (the old wrong
 * pattern) — see `addMessage`'s `conversationId` parameter for the
 * "target a specific conversation that may not be active" path.
 */
export interface MessagesSlice {
  /** Append a message. Defaults to the active conversation; pass
   *  `conversationId` explicitly when a streaming callback may
   *  outlive the user's focus (e.g. they switch chats while a
   *  response is in flight). */
  addMessage: (
    message: Omit<Message, "id" | "timestamp">,
    conversationId?: string
  ) => Message
  deleteMessage: (messageId: string) => void
  updateMessage: (messageId: string, content: string) => void
  truncateMessagesAfter: (messageId: string, inclusive?: boolean) => void
  /** Replace a slice of messages with a synthetic `kind: 'recap'`
   *  assistant message that summarises them. The originals stay on
   *  disk + visible, but are flagged `compressed: true` so the chat
   *  request builder skips them. Returns the inserted recap message
   *  (or null if no messages matched, which only happens if the caller
   *  passes stale ids). */
  compressMessages: (
    conversationId: string,
    messageIds: string[],
    recapContent: string
  ) => Message | null
  /** Inverse of `compressMessages`: removes the recap message and
   *  un-flags every message it stood in for. No-op if `recapMessageId`
   *  doesn't refer to a recap. */
  uncompressRecap: (conversationId: string, recapMessageId: string) => void
  clearMessages: () => void
  appendToMessage: (messageId: string, chunk: string) => void
  appendToMessageReasoning: (messageId: string, chunk: string) => void
  setMessageReasoningDuration: (messageId: string, durationMs: number) => void
  setMessageToolCalls: (messageId: string, toolCalls: ToolCallRecord[]) => void
  setMessageSuggestions: (messageId: string, suggestions: string[]) => void
  appendMessageGeneratedImages: (messageId: string, images: GeneratedImage[]) => void
  /** Append one generative-UI part to the assistant message — emitted
   *  by the `renderUI` tool, dispatched by `use-chat-send` on `ui_part`
   *  SSE frames. Idempotent on `(messageId, part.id)`. See
   *  `docs/PLAN-generative-ui-parts.md`. */
  appendMessageUiPart: (
    messageId: string,
    part: import("@/shared/generative-ui/schemas").PersistedUiPart,
  ) => void
  /** Replace the `url` on a single generated image. Used by the lazy
   *  signed-URL re-sign path (`apiClient.images.refreshUrl`) so the
   *  refreshed URL persists across re-renders without touching the
   *  rest of the image record. No-op if the message or image id
   *  doesn't exist. */
  updateMessageGeneratedImageUrl: (
    messageId: string,
    imageId: string,
    url: string
  ) => void
  setMessageError: (messageId: string, error: MessageError) => void
  clearMessageError: (messageId: string) => void
}

export const createMessagesSlice: SliceCreator<MessagesSlice> = (set) => ({
  addMessage: (message, conversationId) => {
    const newMessage: Message = {
      ...message,
      id: uuid(),
      timestamp: new Date(),
    }
    set((state) => {
      const targetId = conversationId ?? state.activeConversationId
      if (!targetId) return {}
      const updatedConversations = state.conversations.map((c) => {
        if (c.id === targetId) {
          return {
            ...c,
            messages: [...c.messages, newMessage],
            updatedAt: new Date(),
          }
        }
        return c
      })
      return { conversations: updatedConversations }
    })
    return newMessage
  },
  deleteMessage: (messageId) =>
    set((state) => ({
      // Find by messageId across ALL conversations rather than only
      // the active one. Message ids are uuids, so they uniquely
      // identify the owning conversation; filtering on `activeId`
      // here would misfire whenever the user has switched tabs since
      // the message was created — particularly during parallel
      // streams. (Same pattern applied to every other per-message
      // mutator below.)
      conversations: state.conversations.map((c) => {
        if (c.messages.some((m) => m.id === messageId)) {
          return {
            ...c,
            messages: c.messages.filter((m) => m.id !== messageId),
          }
        }
        return c
      }),
      // Detach any bookmarks / artifacts anchored to this message
      // (mirrors the `on delete set null` from the Supabase schema).
      notes: state.notes.map((n) =>
        n.messageId === messageId ? { ...n, messageId: null } : n
      ),
      artifacts: state.artifacts.map((a) =>
        a.messageId === messageId ? { ...a, messageId: null } : a
      ),
    })),
  updateMessage: (messageId, content) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.messages.some((m) => m.id === messageId)) {
          return {
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId ? { ...m, content } : m
            ),
          }
        }
        return c
      }),
    })),
  truncateMessagesAfter: (messageId, inclusive = false) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        const idx = c.messages.findIndex((m) => m.id === messageId)
        if (idx === -1) return c
        const endExclusive = inclusive ? idx : idx + 1
        return { ...c, messages: c.messages.slice(0, endExclusive) }
      }),
    })),
  compressMessages: (conversationId, messageIds, recapContent) => {
    // The array surgery (insert recap, flag the slice, fold any
    // prior recap so a single Undo restores both spans) lives in
    // the pure `buildCompressedMessages` helper. We assign its
    // result out of the `set` updater so the caller still gets the
    // inserted recap back for scroll/focus.
    const recapId = uuid()
    const now = new Date()
    let recap: Message | null = null
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== conversationId) return c
        const built = buildCompressedMessages(
          c.messages,
          messageIds,
          recapId,
          recapContent,
          now
        )
        if (!built) return c
        recap = built.recap
        return { ...c, messages: built.messages, updatedAt: now }
      }),
    }))
    return recap
  },
  uncompressRecap: (conversationId, recapMessageId) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== conversationId) return c
        const recap = c.messages.find(
          (m) => m.id === recapMessageId && m.kind === "recap"
        )
        if (!recap) return c
        const restore = new Set(recap.recapMessageIds ?? [])
        return {
          ...c,
          messages: c.messages
            .filter((m) => m.id !== recapMessageId)
            .map((m) =>
              restore.has(m.id) ? { ...m, compressed: false } : m
            ),
          updatedAt: new Date(),
        }
      }),
    })),
  clearMessages: () =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id === state.activeConversationId) {
          return { ...c, messages: [] }
        }
        return c
      }),
    })),
  appendToMessage: (messageId, chunk) => {
    perfMark("humm/chat/append-message:start")
    perfCount("chat.append.message")
    set((state) => {
      const next = {
        conversations: state.conversations.map((c) => {
          if (c.messages.some((m) => m.id === messageId)) {
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, content: m.content + chunk } : m
              ),
            }
          }
          return c
        }),
      }
      perfMark("humm/chat/append-message:end")
      return next
    })
  },
  appendToMessageReasoning: (messageId, chunk) => {
    perfMark("humm/chat/append-reasoning:start")
    perfCount("chat.append.reasoning")
    set((state) => {
      const next = {
        conversations: state.conversations.map((c) => {
          if (c.messages.some((m) => m.id === messageId)) {
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId
                  ? { ...m, reasoning: (m.reasoning ?? "") + chunk }
                  : m
              ),
            }
          }
          return c
        }),
      }
      perfMark("humm/chat/append-reasoning:end")
      return next
    })
  },
  setMessageReasoningDuration: (messageId, durationMs) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.messages.some((m) => m.id === messageId)) {
          return {
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId
                ? { ...m, reasoningDurationMs: durationMs }
                : m
            ),
          }
        }
        return c
      }),
    })),
  setMessageToolCalls: (messageId, toolCalls) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.messages.some((m) => m.id === messageId)) {
          return {
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId
                ? { ...m, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
                : m
            ),
          }
        }
        return c
      }),
    })),
  setMessageSuggestions: (messageId, suggestions) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.messages.some((m) => m.id === messageId)) {
          return {
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId ? { ...m, suggestions } : m
            ),
          }
        }
        return c
      }),
    })),
  appendMessageGeneratedImages: (messageId, images) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (!c.messages.some((m) => m.id === messageId)) return c
        return {
          ...c,
          messages: c.messages.map((m) => {
            if (m.id !== messageId) return m
            const next = [...(m.generatedImages ?? []), ...images]
            return { ...m, generatedImages: next }
          }),
        }
      }),
    })),
  appendMessageUiPart: (messageId, part) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (!c.messages.some((m) => m.id === messageId)) return c
        return {
          ...c,
          messages: c.messages.map((m) => {
            if (m.id !== messageId) return m
            const existing = m.uiParts ?? []
            // Idempotent on (messageId, part.id) — a duplicate emit
            // (rare; defensive) leaves the message unchanged so the
            // identity-stable render path doesn't churn.
            if (existing.some((p) => p.id === part.id)) return m
            return { ...m, uiParts: [...existing, part] }
          }),
        }
      }),
    })),
  updateMessageGeneratedImageUrl: (messageId, imageId, url) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (!c.messages.some((m) => m.id === messageId)) return c
        return {
          ...c,
          messages: c.messages.map((m) => {
            if (m.id !== messageId) return m
            const images = m.generatedImages
            if (!images) return m
            let changed = false
            const next = images.map((img) => {
              if (img.id !== imageId || img.url === url) return img
              changed = true
              return { ...img, url }
            })
            return changed ? { ...m, generatedImages: next } : m
          }),
        }
      }),
    })),
  setMessageError: (messageId, error) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.messages.some((m) => m.id === messageId)) {
          return {
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId ? { ...m, error } : m
            ),
          }
        }
        return c
      }),
    })),
  clearMessageError: (messageId) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.messages.some((m) => m.id === messageId)) {
          return {
            ...c,
            messages: c.messages.map((m) => {
              if (m.id !== messageId) return m
              const { error: _ignored, ...rest } = m
              void _ignored
              return rest
            }),
          }
        }
        return c
      }),
    })),
})
