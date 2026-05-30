"use client"
import "client-only"

/**
 * After an assistant stream completes, auto-promote substantial /
 * renderable code blocks in the message into first-class `Artifact`s
 * so the user doesn't have to remember the Save-as-artifact button.
 *
 * Threshold logic mirrors the inline auto-archive behaviour that used
 * to live in `components/panels/chat.tsx`:
 *   - blocks ≥ `AUTO_ARCHIVE_MIN_LINES` are archived for length
 *   - shorter renderable blocks (jsx/tsx/html/svg/mermaid, or content
 *     that sniffs as one) are archived because the point of them is
 *     to be *previewed*, not skimmed
 *   - capped at `AUTO_ARCHIVE_MAX_PER_MESSAGE` to keep the artifacts
 *     panel from flooding on a long answer
 *
 * Pure side-effect helper: takes the message content + a
 * `createArtifact` callback (the store mutator) and the conversation
 * id the artifact should attach to. Easy to test in isolation by
 * passing a stub callback.
 */

import type { Artifact } from "@/shared/types"
import { extractCodeBlocks } from "@/shared/code-blocks"
import { detectArtifactShell } from "@/client/live-artifact/detect"

export const AUTO_ARCHIVE_MIN_LINES = 15
export const AUTO_ARCHIVE_MAX_PER_MESSAGE = 3

export interface AutoArchiveInput {
  /** Body of the assistant message (post-stream). */
  content: string
  /** The id of the assistant message — written onto each artifact so
   *  later regenerate / delete flows can find / clear them. */
  messageId: string
  /** The conversation the artifact attaches to (captured at stream-
   *  start so a tab switch mid-stream still routes correctly). */
  conversationId: string
}

/** Same shape `useStore.createArtifact` expects. Kept local rather
 *  than importing the store type so this module stays React-free. */
type CreateArtifactFn = (input: {
  conversationId: string
  messageId?: string | null
  kind: "code" | "markdown" | "json" | "table" | "image" | "other"
  language?: string | null
  title?: string
  content: string
  storagePath?: string | null
}) => Artifact

/**
 * Inspect `content` for fenced code blocks and create artifacts for
 * the ones that pass the threshold. Returns the artifacts it created
 * (empty when nothing qualified). The caller doesn't need to do
 * anything with the return value — it's there for tests and any
 * future "show a toast on first auto-archive" flow.
 */
export function autoArchiveCodeBlocks(
  input: AutoArchiveInput,
  createArtifact: CreateArtifactFn
): Artifact[] {
  const blocks = extractCodeBlocks(input.content)
  const eligible = blocks.filter(
    (b) =>
      b.lines >= AUTO_ARCHIVE_MIN_LINES ||
      detectArtifactShell({ language: b.language ?? null, content: b.code })
        .renderable
  )
  if (eligible.length === 0) return []
  const capped = eligible.slice(0, AUTO_ARCHIVE_MAX_PER_MESSAGE)
  return capped.map((b, i) => {
    const lang = (b.language ?? "").toLowerCase()
    const kind = lang === "json" ? "json" : "code"
    return createArtifact({
      conversationId: input.conversationId,
      messageId: input.messageId,
      kind,
      language: b.language,
      title:
        capped.length === 1
          ? `Code${b.language ? ` (${b.language})` : ""}`
          : `Code ${i + 1}${b.language ? ` (${b.language})` : ""}`,
      content: b.code,
    })
  })
}
