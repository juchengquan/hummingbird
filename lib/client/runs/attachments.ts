import "client-only"

/**
 * A turn's sources as the contract's `forwardedProps.attachments[]`
 * (`RunAttachment`, Q44) — the same files, MCP resources and URL bookmarks
 * the Next chat body sends (`use-chat-send`'s `attachmentsForRequest`),
 * but large inputs by reference:
 *
 * | source | signed-in run (`cloud`) | anonymous run |
 * |---|---|---|
 * | file | `file` by id — agent-py reads the synced `files` row (text, image) itself; no text, no bytes | `inlineFile` with its extracted text |
 * | MCP resource | `mcpResource` by reference — agent-py reads it | same |
 * | URL bookmark | `bookmark` with its cached text | same |
 *
 * An anonymous run has no `searchFiles` (it needs the `files` row), so a
 * RAG-mode file goes inline there — its text is all the model can get.
 * A signed-in run's image files go by id too: agent-py loads the row's
 * `image_data_url`, so the caller sends no image data for them (the
 * `images` of `buildRunInput` stay empty on a signed-in run).
 *
 * **Size.** `/v1/runs` caps the body at 16 MB (Q44). The text sent is
 * clipped to what the backend can render under its attachment budget
 * (`TOTAL_ATTACHMENT_BUDGET`): a running count of the text before an item
 * (counting a cloud file's text the browser knows, never larger than what
 * the backend renders before it) bounds what the renderer has left, and
 * an item is cut to one character past that — the renderer cuts it at
 * least as far and still marks it truncated or omitted, so the prompt is
 * the one the full text would give. At most 40 attachments (the contract's
 * cap), files first.
 *
 * Pure.
 */

import { TOTAL_ATTACHMENT_BUDGET } from "@/shared/attachments"
import type { McpResource, UploadedFile, UrlBookmark } from "@/shared/types"
import { toISO } from "@/shared/utils"

import type { RunAttachment } from "./types"

/** The contract's caps (`RunForwardedProps.attachments`, `RunAttachment`). */
export const RUN_ATTACHMENTS_MAX = 40
const INLINE_TEXT_MAX = 120_000
const BOOKMARK_TEXT_MAX = 220_000
const NAME_MAX = 500
const MIME_MAX = 100
const KIND_MAX = 40
const ID_MAX = 64
const URL_MAX = 2000

export interface RunAttachmentSources {
  /** The attached files (`buildAttachments(…).attachedFiles`). */
  files: readonly UploadedFile[]
  /** `Conversation.fileRetrievalModes`. */
  retrievalModes?: Readonly<Record<string, "rag">>
  mcpResources?: readonly McpResource[]
  bookmarks?: readonly UrlBookmark[]
  /** A signed-in run (`RunsTarget.authToken` set): files go by id. */
  cloud: boolean
  /** Text budget the clipping assumes (tests). */
  budget?: number
}

/** Cut `text` to what the backend can still render after `used` chars. */
function clip(text: string, used: number, budget: number, max: number): { text: string; cut: boolean } {
  const room = Math.max(1, budget - used + 1)
  const limit = Math.min(room, max)
  return text.length > limit ? { text: text.slice(0, limit), cut: true } : { text, cut: false }
}

const cap = (s: string | undefined, n: number): string | undefined => (s ? s.slice(0, n) : undefined)

export function runAttachmentsFor(src: RunAttachmentSources): RunAttachment[] {
  const budget = src.budget ?? TOTAL_ATTACHMENT_BUDGET
  const modes = src.retrievalModes ?? {}
  const out: RunAttachment[] = []
  let used = 0

  for (const f of src.files) {
    const name = f.name.slice(0, NAME_MAX) || "file"
    const rag = modes[f.id] === "rag"
    if (src.cloud) {
      out.push({
        kind: "file",
        fileId: f.id.slice(0, ID_MAX),
        name,
        ...(cap(f.type, MIME_MAX) ? { mimeType: cap(f.type, MIME_MAX) } : {}),
        sizeBytes: Math.max(0, Math.floor(f.size)),
        ...(cap(f.extractedKind, KIND_MAX) ? { extractedKind: cap(f.extractedKind, KIND_MAX) } : {}),
        ...(rag ? { retrievalMode: "rag" as const } : {}),
      })
      if (!rag) used += f.extractedText?.length ?? 0
      continue
    }
    const text = f.extractedText
    const clipped = text ? clip(text, used, budget, INLINE_TEXT_MAX) : null
    if (clipped) used += clipped.text.length
    out.push({
      kind: "inlineFile",
      name,
      ...(cap(f.type, MIME_MAX) ? { mimeType: cap(f.type, MIME_MAX) } : {}),
      sizeBytes: Math.max(0, Math.floor(f.size)),
      ...(cap(f.extractedKind, KIND_MAX) ? { extractedKind: cap(f.extractedKind, KIND_MAX) } : {}),
      ...(clipped ? { text: clipped.text } : {}),
      // `truncated` is the extraction's flag (the header says so); a cut
      // made here is re-made, and marked, by the renderer.
      ...(f.extractionTruncated ? { truncated: true } : {}),
    })
  }

  for (const r of src.mcpResources ?? []) {
    out.push({
      kind: "mcpResource",
      id: r.id.slice(0, ID_MAX),
      serverId: r.serverId.slice(0, ID_MAX),
      uri: r.uri.slice(0, URL_MAX),
      name: r.name.slice(0, NAME_MAX) || r.uri.slice(0, NAME_MAX),
      ...(cap(r.mimeType, MIME_MAX) ? { mimeType: cap(r.mimeType, MIME_MAX) } : {}),
    })
  }

  for (const b of src.bookmarks ?? []) {
    const clipped = clip(b.content, used, budget, BOOKMARK_TEXT_MAX)
    used += clipped.text.length
    out.push({
      kind: "bookmark",
      id: b.id.slice(0, ID_MAX),
      url: b.url.slice(0, URL_MAX),
      title: b.title.slice(0, NAME_MAX) || b.url.slice(0, NAME_MAX),
      text: clipped.text,
      ...(b.contentTruncated ? { truncated: true } : {}),
      fetchedAt: toISO(b.fetchedAt),
    })
  }

  return out.slice(0, RUN_ATTACHMENTS_MAX)
}
