/**
 * Source-attachment types — files, MCP resources, URL bookmarks.
 *
 * `AttachmentPayload` is the wire shape on the chat request body. Files
 * and URL bookmarks carry text content (extracted client-side or
 * server-side at save time); MCP resources carry pointers only and the
 * chat route resolves them via `readResource`.
 *
 * The post-resolution server-side shape lives in
 * `lib/server/attachments/render.ts` as `ResolvedAttachment`.
 */

export type AttachmentKind = 'file' | 'mcp_resource' | 'url_bookmark'

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
