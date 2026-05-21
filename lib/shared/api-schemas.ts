import { z } from 'zod'

/**
 * Shared request + response schemas for the app's API surface. These are
 * the contract every frontend → backend interaction must satisfy.
 *
 * Two purposes:
 *
 *   1. Server-side validation at the route boundary so we fail fast on
 *      malformed clients instead of letting bad payloads reach the AI
 *      SDK / Slate / pdf-parse with confusing downstream errors.
 *
 *   2. A single source of truth for the wire shapes. When the backend
 *      is rewritten in Python (see docs/PLAN-backend-extraction.md),
 *      these schemas describe what Python must accept and emit. The
 *      streaming SSE protocol for /api/chat is documented in
 *      docs/API.md — Zod doesn't model streams cleanly so the doc
 *      carries that contract.
 *
 * Keep in sync with consumers:
 *
 *   - components/panels/chat.tsx           (chat)
 *   - components/editor/use-chat.ts        (command — Plate-driven)
 *   - components/editor/plugins/copilot-kit.tsx (copilot — Plate-driven)
 *   - lib/extract.ts                       (extract + summarize)
 *   - components/share-dialog.tsx          (share create)
 *   - components/conversation-summary-dialog.tsx (summarize)
 */

// --- Building blocks --------------------------------------------------------

const FileSummarySchema = z.object({
  name: z.string().max(500),
  size: z.number().int().nonnegative(),
  type: z.string().max(200),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
  kind: z.string().max(40).optional(),
})

// `ModelMessage` is broader than what we send today, but matches what the AI
// SDK accepts (string OR an array of typed parts for multimodal). We validate
// the outer shape and trust the AI SDK to validate the inner part variants.
const MessagePartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), image: z.union([z.string(), z.instanceof(URL)]) }),
  z.object({ type: z.literal('file'), data: z.unknown(), mediaType: z.string() }),
])

const ModelMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.union([z.string(), z.array(MessagePartSchema)]),
})

// --- /api/chat --------------------------------------------------------------
// Streaming response — see docs/API.md for the SSE frame protocol. There
// is no JSON response schema; the wire format is `data: <json>\n\n`
// frames described in that doc.

// MCP server + its cached capabilities + (for local-mode) the
// credential the client wants the server to use on its behalf this
// turn. Cloud-mode credentials (Stage 3) come from Supabase and are
// not sent in the request body.
const McpRequestServerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  url: z.string().url().max(2000),
  transport: z.literal('http'),
  enabled: z.boolean().optional(),
  capabilities: z
    .object({
      tools: z
        .array(
          z.object({
            name: z.string().max(200),
            description: z.string().max(2000).optional(),
            // JSON schema — kept loose; we forward verbatim to the AI SDK.
            inputSchema: z.unknown().optional(),
          })
        )
        .max(64)
        .optional(),
    })
    .optional(),
  credentials: z
    .object({
      type: z.string().max(40).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
})

export const ChatRequestSchema = z.object({
  messages: z.array(ModelMessageSchema).min(1),
  model: z.string().max(100).optional(),
  files: z.array(FileSummarySchema).max(20).optional(),
  workspaceSystemPrompt: z.string().max(20_000).optional(),
  skills: z
    .array(z.object({ id: z.string().max(40) }))
    .max(10)
    .optional(),
  mcpServers: z.array(McpRequestServerSchema).max(8).optional(),
})

// --- /api/ai/copilot --------------------------------------------------------
// Streaming response — plain text stream consumed by Plate's copilot
// plugin. No JSON response schema.

export const CopilotRequestSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().max(100).optional(),
  prompt: z.string().max(50_000),
  system: z.string().max(20_000).optional(),
})

// --- /api/extract -----------------------------------------------------------
// Request: multipart/form-data with a `file` field. Not modeled as Zod
// because Zod doesn't see FormData. Validated at the route by FormData
// inspection + file-size check.

export const ExtractionResponseSchema = z.object({
  kind: z.enum([
    'pdf',
    'docx',
    'markdown',
    'csv',
    'json',
    'text',
    'image',
    'html',
    'code',
    'spreadsheet',
    'unsupported',
  ]),
  text: z.string(),
  truncated: z.boolean(),
  language: z.string().optional(),
})

// --- /api/summarize ---------------------------------------------------------
// Discriminated union: `file` mode for upload summaries, `conversation`
// mode for the chat-summary dialog. Response shape differs by mode.

const FileSummarizeRequest = z.object({
  mode: z.literal('file'),
  name: z.string().max(500).optional(),
  text: z.string().min(1).max(50_000),
  model: z.string().max(100).optional(),
})

const ConversationSummarizeRequest = z.object({
  mode: z.literal('conversation'),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })
    )
    .min(1)
    .max(200),
  model: z.string().max(100).optional(),
})

export const SummarizeRequestSchema = z.discriminatedUnion('mode', [
  FileSummarizeRequest,
  ConversationSummarizeRequest,
])

export const FileSummarizeResponseSchema = z.object({
  summary: z.string(),
  keyTopics: z.array(z.string()).optional(),
})

export const ConversationSummarizeResponseSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
})

// --- /api/share -------------------------------------------------------------
// POST: mint a share token. DELETE /api/share/[token]: revoke.

// Two shapes: conversation shares target a conversation; document shares
// target a specific document (workspaces own N documents now).
export const CreateShareRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('conversation'),
    conversationId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('document'),
    documentId: z.string().uuid(),
  }),
])

export const CreateShareResponseSchema = z.object({
  token: z.string(),
  kind: z.enum(['conversation', 'document']),
})

export const RevokeShareResponseSchema = z.object({
  ok: z.literal(true),
})

// --- Generic error envelope -------------------------------------------------
// Non-streaming routes return `{ error, code?, message? }` with a non-2xx
// status on failure. Frontend categorisation lives in lib/api-errors.ts.

export const ErrorResponseSchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
})

// --- TS types (inferred from the schemas above) -----------------------------

export type ChatRequestInput = z.infer<typeof ChatRequestSchema>
export type CopilotRequestInput = z.infer<typeof CopilotRequestSchema>
export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>
export type SummarizeRequestInput = z.infer<typeof SummarizeRequestSchema>
export type FileSummarizeResponse = z.infer<typeof FileSummarizeResponseSchema>
export type ConversationSummarizeResponse = z.infer<typeof ConversationSummarizeResponseSchema>
export type CreateShareRequestInput = z.infer<typeof CreateShareRequestSchema>
export type CreateShareResponse = z.infer<typeof CreateShareResponseSchema>
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
