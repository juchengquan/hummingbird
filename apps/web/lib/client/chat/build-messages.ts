"use client"
import "client-only"

/**
 * Pure history → API-payload helper extracted from
 * `components/panels/chat.tsx`. Drops `compressed` messages (they stay
 * on disk + render in the recap card but the model no longer sees
 * them) and attaches image URLs to the last user turn only.
 *
 * Returned shape is compatible with both `ChatRequestInput["messages"]`
 * and `TaskRequestInput["messages"]`; cast at the call site.
 *
 * Pure: tested in `build-messages.test.ts`.
 */

import type { Message } from "@/shared/types"

type TextOnlyMsg = { role: Message["role"]; content: string }
type MultimodalUserMsg = {
  role: Message["role"]
  content: Array<
    { type: "text"; text: string } | { type: "image"; image: string }
  >
}
export type BuiltMessage = TextOnlyMsg | MultimodalUserMsg

/**
 * Build the API-shaped messages array from the in-store history.
 *
 * The image attachment policy mirrors the original inline behaviour:
 *   - images go on the most recent message **only if** that message is
 *     a user turn AND there is at least one image URL.
 *   - all earlier messages send as plain text-content shape.
 *
 * `compressed` messages are dropped. The recap message that replaced
 * them stays in the array and travels to the model as a regular
 * assistant turn — the whole point of the compression action.
 */
export function buildTransmittedMessages(
  history: Message[],
  attachedImageUrls: string[]
): BuiltMessage[] {
  const transmittedHistory = history.filter((m) => !m.compressed)
  return transmittedHistory.map((m, i) => {
    const isLastUser =
      i === transmittedHistory.length - 1 &&
      m.role === "user" &&
      attachedImageUrls.length > 0
    if (!isLastUser) {
      return { role: m.role, content: m.content }
    }
    return {
      role: m.role,
      content: [
        { type: "text", text: m.content },
        ...attachedImageUrls.map((url) => ({
          type: "image" as const,
          image: url,
        })),
      ],
    }
  })
}
