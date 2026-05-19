import { z } from 'zod'

/**
 * Shared request-body schemas for the AI Gateway routes. Used at the route
 * boundary so we fail fast on malformed clients instead of letting bad
 * payloads reach the AI SDK / Slate / pdf-parse with confusing downstream
 * errors. Keep these in sync with the request shapes in:
 *
 *   - components/panels/chat.tsx (chat)
 *   - components/editor/use-chat.ts (command)
 *   - components/editor/plugins/copilot-kit.tsx (copilot)
 */

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

export const ChatRequestSchema = z.object({
  messages: z.array(ModelMessageSchema).min(1),
  model: z.string().max(100).optional(),
  files: z.array(FileSummarySchema).max(20).optional(),
  workspaceSystemPrompt: z.string().max(20_000).optional(),
  skills: z
    .array(z.object({ id: z.string().max(40) }))
    .max(10)
    .optional(),
})

export const CopilotRequestSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().max(100).optional(),
  prompt: z.string().max(50_000),
  system: z.string().max(20_000).optional(),
})

export type ChatRequestInput = z.infer<typeof ChatRequestSchema>
export type CopilotRequestInput = z.infer<typeof CopilotRequestSchema>
