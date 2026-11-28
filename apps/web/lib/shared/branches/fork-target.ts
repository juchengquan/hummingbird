import type { Message } from "@/shared/types"

/** The message id to fork at when editing a user message: the edited
 *  message itself. `forkConversation` copies `[0..i]` inclusive, so the
 *  fork's last message is the edited turn. Returns null if absent. */
export function forkTargetForEdit(
  messages: Message[],
  messageId: string,
): string | null {
  return messages.some((m) => m.id === messageId) ? messageId : null
}

/** The message id to fork at when regenerating an assistant reply: the
 *  nearest preceding user message (the prompt). Forking there and
 *  resending yields a fresh reply while the original is preserved on the
 *  source. Returns null if the assistant id is absent or no user message
 *  precedes it. */
export function forkTargetForRegenerate(
  messages: Message[],
  assistantMessageId: string,
): string | null {
  const idx = messages.findIndex((m) => m.id === assistantMessageId)
  if (idx <= 0) return null
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].id
  }
  return null
}
