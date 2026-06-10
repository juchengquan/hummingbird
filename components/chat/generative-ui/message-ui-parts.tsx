"use client"
import "client-only"

/**
 * Renders the `Message.uiParts` array on an assistant message bubble.
 *
 * Each entry resolves through the client registry; unknown kinds and
 * parts whose props fail schema validation drop silently so a stale
 * server can't crash the bubble.
 *
 * Resolution wiring (commit 2): when the user submits an interactive
 * part, this component:
 *   1. Persists the answer via `resolveMessageUiPart` so reload
 *      surfaces the inert state.
 *   2. Formats the answer into a follow-up user-turn text via
 *      `formatAnswerForChat` (pure helper).
 *   3. Dispatches per `defaultResolutionFor(kind)`:
 *        - "auto-send" → calls the chat panel's `onSendUserMessage`
 *          (a callback the chat panel injects since `useChatSend`
 *          lives at the panel level).
 *        - "prefill"   → writes the formatted text to
 *          `setPendingChatInput`; the composer picks it up and the
 *          user sends after review.
 */

import { useStore } from "@/client/hooks/use-store"
import { getUiKindDef } from "@/client/chat/generative-ui/registry"
import {
  defaultResolutionFor,
  formatAnswerForChat,
  type PersistedUiPart,
  type UiAnswer,
} from "@/shared/generative-ui/schemas"

interface MessageUiPartsProps {
  parts: readonly PersistedUiPart[]
  /** Auto-send dispatcher. The chat panel passes a callback that
   *  appends a synthetic user message + invokes the send pipeline.
   *  Optional — when absent, every resolution falls back to the
   *  composer-prefill path so the user always has *some* recourse. */
  onSendUserMessage?: (text: string) => void
}

export function MessageUiParts({ parts, onSendUserMessage }: MessageUiPartsProps) {
  const resolveMessageUiPart = useStore((s) => s.resolveMessageUiPart)
  const setPendingChatInput = useStore((s) => s.setPendingChatInput)
  const messageId = useStore((s) => {
    // Resolve the assistant message id this `MessageUiParts` is
    // mounted on. The parts list is unique-per-message; we look up
    // any conversation hosting any of these part ids to derive the
    // owning message. Cheap because the active conversation's
    // messages are already in memory.
    const partIds = new Set(parts.map((p) => p.id))
    for (const c of s.conversations) {
      for (const m of c.messages) {
        if (!m.uiParts || m.uiParts.length === 0) continue
        if (m.uiParts.some((p) => partIds.has(p.id))) return m.id
      }
    }
    return null
  })

  const handleResolve = (part: PersistedUiPart, answer: UiAnswer) => {
    if (!messageId) return
    // Persist first so reload / re-render preserves the answer.
    resolveMessageUiPart(messageId, part.id, answer)
    const text = formatAnswerForChat({ kind: part.kind, props: part.props }, answer)
    if (!text) return
    const strategy = defaultResolutionFor(part.kind)
    if (strategy === "auto-send" && onSendUserMessage) {
      onSendUserMessage(text)
    } else {
      // Prefill the composer — the existing `pendingChatInput`
      // machinery in the chat panel picks this up on next render.
      setPendingChatInput(text)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {parts.map((part) => {
        const def = getUiKindDef(part.kind)
        if (!def) return null
        const parsed = def.schema.safeParse(part.props)
        if (!parsed.success) return null
        const Component = def.Component
        const inert = !!part.answeredAt
        return (
          <Component
            key={part.id}
            props={parsed.data}
            inert={inert}
            answer={part.answer}
            onResolve={(a) => handleResolve(part, a)}
          />
        )
      })}
    </div>
  )
}
