/**
 * Source-attachment types — files, MCP resources, URL bookmarks.
 *
 * Three names, three jobs (see `docs/PLAN-attachments-polymorphism.md`
 * for the rationale):
 *
 *   `SourceAttachment`   — store-side discriminated union with the
 *                          full entity. UI rows, hover previews, the
 *                          attached-count indicator consume this.
 *
 *   `AttachmentPayload`  — wire shape on the chat request body.
 *                          Files + URL bookmarks carry text content
 *                          (extracted client-side or server-side at
 *                          save time). MCP resources carry pointers
 *                          only; the chat route resolves them via
 *                          `readResource`.
 *
 *   `ResolvedAttachment` — server-side post-resolution shape. Lives
 *                          in `lib/server/attachments/render.ts`.
 */

import type { McpResource, UploadedFile, UrlBookmark } from './types'

export type AttachmentKind = 'file' | 'mcp_resource' | 'url_bookmark'

/** Store-side: the full entity, exactly as it lives in the Zustand
 *  store. Consumers that want to render a row work with this. */
export type SourceAttachment =
  | { kind: 'file'; id: string; entity: UploadedFile }
  | { kind: 'mcp_resource'; id: string; entity: McpResource }
  | { kind: 'url_bookmark'; id: string; entity: UrlBookmark }

/** Wire-side: minimum the server needs to render the system prompt.
 *  Asymmetric by design — see the doc comment at the top of the file. */
export type AttachmentPayload =
  | { kind: 'file'; summary: FileSummary }
  | { kind: 'mcp_resource'; ref: McpResourceRef }
  | { kind: 'url_bookmark'; bookmark: UrlBookmarkRef }

export interface FileSummary {
  name: string
  size: number
  type: string
  /** Plain-text content extracted by /api/extract. Undefined when
   *  extraction is pending or unsupported. */
  text?: string
  /** True when `text` was cut to fit the extraction budget. */
  truncated?: boolean
  /** Coarse content kind reported by /api/extract — 'pdf', 'docx',
   *  'code', 'spreadsheet', etc. Labels the per-file header so the
   *  model knows what flavour of text it's looking at. */
  kind?: string
}

export interface McpResourceRef {
  /** McpResource.id (client-side cache id), so the chat route can
   *  log which resource was requested even when resolution fails. */
  id: string
  serverId: string
  uri: string
  name: string
  mimeType?: string
}

export interface UrlBookmarkRef {
  /** UrlBookmark.id, surfaced in errors so a refresh prompt can
   *  point at the right row. */
  id: string
  url: string
  title: string
  /** Cached extracted text (server-extracted at save time). */
  content: string
  contentTruncated: boolean
  /** ISO 8601 — surfaced inline so the model knows how fresh the
   *  cache is. */
  fetchedAt: string
}

/** Returns the (kind, id) tuple for a store-side attachment.
 *  Used by selection state and de-dup across kinds. */
export function attachmentRef(
  att: SourceAttachment
): { kind: AttachmentKind; id: string } {
  return { kind: att.kind, id: att.id }
}

/** True when two attachment refs identify the same store entity. */
export function attachmentRefEquals(
  a: { kind: AttachmentKind; id: string },
  b: { kind: AttachmentKind; id: string }
): boolean {
  return a.kind === b.kind && a.id === b.id
}
