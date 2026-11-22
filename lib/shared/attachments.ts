/**
 * Source-attachment types — files, MCP resources, URL bookmarks.
 *
 * `AttachmentPayload` is the wire shape on the chat request body. Types
 * are inferred from the Zod schemas in `api-schemas.ts` so a schema
 * change can't silently drift from the TS contract.
 *
 * Files and URL bookmarks carry content (extracted client-side or
 * server-side at save time); MCP resources carry pointers and the
 * chat route resolves them via `readResource`. The post-resolution
 * server-side shape lives in `lib/server/attachments/render.ts` as
 * `ResolvedAttachment`.
 */

import type { z } from 'zod'
import type {
  AttachmentPayloadSchema,
  FileSummarySchema,
  McpResourceRefSchema,
  UrlBookmarkRefSchema,
} from './api-schemas'

export type AttachmentPayload = z.infer<typeof AttachmentPayloadSchema>
export type AttachmentKind = AttachmentPayload['kind']

export type FileSummary = z.infer<typeof FileSummarySchema>
export type McpResourceRef = z.infer<typeof McpResourceRefSchema>
export type UrlBookmarkRef = z.infer<typeof UrlBookmarkRefSchema>

/** Soft cap on the combined attachment text one system prompt carries
 *  (characters, across files, MCP resources and bookmarks). The Next
 *  chat route (`lib/server/chat/prompt-builders.ts`) and agent-py
 *  (`runs/context.py`) render under it; a turn on runs clips what it
 *  sends to it (`lib/client/runs/attachments.ts`). */
export const TOTAL_ATTACHMENT_BUDGET = 300 * 1024
