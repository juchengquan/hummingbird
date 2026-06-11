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

/** Per-kind sub-schemas for the attachment payload. Extracted at
 *  module scope (rather than inline inside `AttachmentPayloadSchema`)
 *  so `lib/shared/attachments.ts` can derive its TS types via
 *  `z.infer` — single source of truth, no drift between schema and
 *  type. */
export const FileSummarySchema = z.object({
  name: z.string().max(500),
  size: z.number().int().nonnegative().max(1_000_000_000),
  type: z.string().max(100),
  text: z.string().max(120_000).optional(),
  truncated: z.boolean().optional(),
  kind: z.string().max(40).optional(),
  /** Per-attachment retrieval mode. Absent / `'inline'` (default) →
   *  the file's `text` is inlined into the system prompt. `'rag'` →
   *  the server suppresses the body and instead notes the file as
   *  retrievable via the `searchFiles` skill. The chat route also
   *  force-enables `searchFiles` when any attachment is in rag mode
   *  so the user doesn't have to remember to tick the skill. See
   *  `docs/PLAN-cross-product-inspirations.md` item #6. */
  retrievalMode: z.enum(["inline", "rag"]).optional(),
})

export const McpResourceRefSchema = z.object({
  id: z.string().min(1).max(64),
  serverId: z.string().min(1).max(64),
  uri: z.string().min(1).max(2000),
  name: z.string().min(1).max(500),
  mimeType: z.string().max(100).optional(),
})

export const UrlBookmarkRefSchema = z.object({
  id: z.string().min(1).max(64),
  url: z.string().min(1).max(2000),
  title: z.string().min(1).max(500),
  content: z.string().max(220_000),
  contentTruncated: z.boolean(),
  fetchedAt: z.string(),
})

export const AttachmentPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), summary: FileSummarySchema }),
  z.object({ kind: z.literal('mcp_resource'), ref: McpResourceRefSchema }),
  z.object({ kind: z.literal('url_bookmark'), bookmark: UrlBookmarkRefSchema }),
])

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
            // MCP Apps: ui:// resource the tool renders (local-mode
            // servers transmit it; absent for ordinary tools). See
            // docs/PLAN-mcp-apps.md.
            uiResourceUri: z.string().max(2000).optional(),
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
  workspaceSystemPrompt: z.string().max(20_000).optional(),
  /** Active workspace id — required to look up cloud-mode MCP servers
   *  server-side. Local-mode servers are passed in `mcpServers` and
   *  don't need this. Optional so signed-out usage still works. */
  workspaceId: z.string().max(64).optional(),
  /** Client-side "Store files locally" preference (from the account
   *  menu). When true, the chat route's image-persistence layer skips
   *  Supabase Storage and returns data URLs instead — same semantic as
   *  the client's `persistFile()` honouring the same flag for uploads.
   *  Absent / false → cloud upload is allowed when a session exists. */
  localFilesOnly: z.boolean().optional(),
  /** Reasoning-effort tier for models that expose a thinking-budget /
   *  `reasoning_effort` knob. Absent → provider default. Mapped onto
   *  provider options server-side; ignored for models/providers without
   *  a mapping. See `@/shared/reasoning-effort`. */
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  skills: z
    .array(
      z.object({
        id: z.string().max(40),
        /** Optional structured config — currently only the `webSearch`
         *  skill reads it. Ignored for other skills. Provider toggles
         *  and per-provider settings (search depth, freshness) live
         *  inside `webSearchConfig`; see `lib/shared/skills/web-search-config.ts`. */
        webSearchConfig: z
          .object({
            maxCalls: z.number().int().min(1).max(50).optional(),
            tavily: z
              .object({
                enabled: z.boolean().optional(),
                searchDepth: z.enum(["basic", "advanced"]).optional(),
              })
              .optional(),
            brave: z
              .object({
                enabled: z.boolean().optional(),
                freshness: z.enum(["any", "pd", "pw", "pm", "py"]).optional(),
              })
              .optional(),
            exa: z
              .object({
                enabled: z.boolean().optional(),
                type: z.enum(["auto", "neural", "keyword"]).optional(),
              })
              .optional(),
          })
          .optional(),
        /** Optional structured config for the `webFetch` skill. Single
         *  `maxCalls` field today; cascade machinery is in place for
         *  future knobs. */
        webFetchConfig: z
          .object({
            maxCalls: z.number().int().min(1).max(50).optional(),
          })
          .optional(),
        /** Optional structured config for the `imageGen` skill (Minimax
         *  T2I/I2I). Server clamps both `maxCalls` and `aspectRatio`
         *  via `resolveImageGenConfig` so client-side garbage is safe. */
        imageGenConfig: z
          .object({
            maxCalls: z.number().int().min(1).max(50).optional(),
            aspectRatio: z
              .enum(["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"])
              .optional(),
          })
          .optional(),
        /** Optional structured config for the `searchFiles` skill. Single
         *  `maxCalls` field; server already clamps via clampMaxSearchFiles. */
        fileSearchConfig: z
          .object({
            maxCalls: z.number().int().min(1).max(50).optional(),
          })
          .optional(),
      })
    )
    .max(10)
    .optional(),
  /** MCP server configs (with cached capabilities + local-mode creds)
   *  for tool registration. Distinct from `attachments` — these are
   *  the **servers** whose tools the model can call; attachments of
   *  `kind: 'mcp_resource'` are the **resources** whose content the
   *  model reads. */
  mcpServers: z.array(McpRequestServerSchema).max(8).optional(),
  /** Everything attached to this turn — files, MCP resources, URL
   *  bookmarks — in one discriminated array. Workspace-ticked +
   *  conversation-pinned, de-duped client-side, tombstones filtered.
   *  See `lib/shared/attachments.ts` for the union shape. */
  attachments: z.array(AttachmentPayloadSchema).max(40).optional(),
  /** I2I reference image for the next turn. Set by the "Remix" action
   *  on a `GeneratedImagesGallery` tile. When present, the server
   *  appends a system note instructing the model to call
   *  `generateImage` with `referenceImageUrl` set; the tool's own
   *  SSRF gate validates the URL before forwarding to Minimax. Cleared
   *  by the client on send. */
  referenceImage: z
    .object({
      url: z.string().url().max(4000),
    })
    .optional(),
})

// --- /api/ai/complete -------------------------------------------------------
// Inline editor ghost-text autocomplete. Streaming plain-text response
// (a short continuation of `blockText`, biased by the preceding `prefix`
// of the document). Plate's Copilot plugin consumes the stream.
// See `docs/PLAN-inline-autocomplete.md`.

/** Max bytes of preceding-document context. Prefix beyond this cap is
 *  truncated server-side (keeping the trailing window — the bit closest
 *  to the cursor). Roughly ~1–2k tokens, the plan's pinned cap. */
export const COMPLETE_PREFIX_MAX = 8_000

/** Max bytes of the current block's text. Plate sends one block via
 *  `getPrompt`, so the cap is generous but bounded. */
export const COMPLETE_BLOCK_MAX = 4_000

export const CompleteRequestSchema = z.object({
  /** Preceding-document context (markdown). Truncated to the trailing
   *  `COMPLETE_PREFIX_MAX` chars before the prompt is built. */
  prefix: z.string().max(COMPLETE_PREFIX_MAX * 4).optional(),
  /** Current block's text (markdown). The completion continues this. */
  blockText: z.string().max(COMPLETE_BLOCK_MAX),
  /** Model id override. Defaults to the fast model the editor uses
   *  elsewhere (`google/gemini-2.5-flash`). */
  model: z.string().max(100).optional(),
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
  /** Full extracted text (up to FULL_EXTRACTION_BUDGET ≈ 1 MB), used
   *  by the Phase 3 `readFileSection` tool. Only set when the file's
   *  raw text exceeded the inline `text` budget — when they would be
   *  equal, this is omitted to avoid doubling the wire payload. See
   *  `docs/PLAN-file-full-text-retrieval.md`. */
  fullText: z.string().max(1_200_000).optional(),
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

// Compress mode — produces a tight markdown recap intended to REPLACE
// the input messages in the chat history (i.e. the model reads it on
// the next turn as a substitute for the originals). Different content
// shape from `conversation` mode (which is for human display).
const CompressSummarizeRequest = z.object({
  mode: z.literal('compress'),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })
    )
    .min(2)
    .max(200),
  model: z.string().max(100).optional(),
})

const ProjectBreakdownRequest = z.object({
  mode: z.literal('project-breakdown'),
  goal: z.string().min(1).max(4000),
  existingTitles: z.array(z.string().max(300)).max(100).optional(),
  model: z.string().max(100).optional(),
})

export const SummarizeRequestSchema = z.discriminatedUnion('mode', [
  FileSummarizeRequest,
  ConversationSummarizeRequest,
  CompressSummarizeRequest,
  ProjectBreakdownRequest,
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

export const CompressSummarizeResponseSchema = z.object({
  /** Markdown recap intended to substitute for the input messages on
   *  the next chat turn. Information-dense; preserves names, facts,
   *  decisions, and any file/URL references the assistant might still
   *  need to reason about. */
  recap: z.string().min(1).max(10_000),
})

export const ProjectBreakdownResponseSchema = z.object({
  /** Proposed task titles for the project board. The user picks which
   *  to import; each becomes a To-do card. */
  titles: z.array(z.string().min(1).max(300)).max(20),
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

// --- /api/tasks (long-running task — streaming) -----------------------------
// A task is a chat-shaped request that runs as a multi-step agent loop and
// streams the AI-SDK data stream of `data-agent-event` parts (see
// `lib/shared/agent/wire.ts`). Reuses the chat message + skills shapes;
// adds `conversationId` (the run is scoped to a conversation) and `maxSteps`.

export const TaskRequestSchema = z.object({
  messages: z.array(ModelMessageSchema).min(1),
  conversationId: z.string().min(1).max(64),
  model: z.string().max(100).optional(),
  workspaceSystemPrompt: z.string().max(20_000).optional(),
  workspaceId: z.string().max(64).optional(),
  /** Step ceiling for the loop. Clamped server-side. */
  maxSteps: z.number().int().min(1).max(50).optional(),
  /** Same per-skill entries as the chat request. */
  skills: ChatRequestSchema.shape.skills,
  /** Local-mode MCP servers (with creds), same shape as the chat
   *  request. Cloud-mode servers are looked up server-side from
   *  `workspaceId`, so this is only needed for local-mode. */
  mcpServers: ChatRequestSchema.shape.mcpServers,
  /** Tool names (full, prefixed for MCP) that require human approval
   *  before running. The runner registers them without an `execute`;
   *  the model can call them but the SDK won't run them — the run
   *  suspends so the human can approve/reject. v1 source: the client
   *  passes the list explicitly (e.g. all MCP tools from sensitive
   *  servers). Server-side policy (per-tool flags) is a follow-up. */
  requireApprovalFor: z.array(z.string().min(1)).max(64).optional(),
  /** Task mode (`PLAN-deep-research.md`). `'research'` swaps the
   *  default system prompt for the research-mode loop (plan →
   *  per-section search → gap pass → synthesize a cited Markdown
   *  report). `undefined` / omission keeps default behaviour. */
  mode: z.enum(["default", "research"]).optional(),
  /** MCP server allow-list for this run (`PLAN-custom-agents.md`
   *  Phase 2). When set, only cloud-mode MCP servers whose id appears
   *  here are loaded server-side. `undefined` / omission means "no
   *  restriction" (cascade through workspace defaults). */
  allowedMcpServerIds: z.array(z.string().max(64)).max(64).optional(),
})

// --- /api/tasks/:id/respond -------------------------------------------------
// Resolve a HITL pending input — approve/reject a gated tool, choose
// one of the options, or supply a value. Only the fields for the
// request's `kind` need to be set. Returns the continuation stream.

/**
 * `POST /api/tasks` reply — `202 { runId }`. The client then opens
 * `GET /api/tasks/:id/stream` to watch events as the worker produces
 * them. There is no inline stream from POST after Phase 6 steps 3+4
 * (`PLAN-agent-task-queue.md`).
 */
export const TaskStartResponseSchema = z.object({
  runId: z.string().min(1),
})

/** `POST /api/tasks/:id/respond` reply — `202 { ok: true }`. The
 *  client uses its existing resume-stream subscription to see the
 *  continuation. */
export const RespondResponseSchema = z.object({
  ok: z.literal(true),
})

export const RespondRequestSchema = z.object({
  requestId: z.string().min(1),
  /** `requestKind: "approval"` — required for tool gates. */
  approved: z.boolean().optional(),
  /** `requestKind: "approval"` — edited args to use instead of what
   *  the model proposed. Server validates before executing. */
  args: z.unknown().optional(),
  /** `requestKind: "choice"` — picked option ids. */
  selection: z.array(z.string()).optional(),
  /** `requestKind: "input"` — free-text value. */
  value: z.string().optional(),
  /** `requestKind: "ui-part"` — the user's structured answer to a
   *  `renderUI` HITL gate. Shape mirrors the chat-mode `UiAnswer`
   *  discriminated union. The runner runs `formatAnswerForChat` on
   *  the server side to inject the answer as the tool's result on
   *  continuation. See `docs/PLAN-generative-ui-parts.md` commit 3. */
  uiAnswer: z.unknown().optional(),
  /** Local-mode MCP creds re-supplied for the continuation. */
  mcpServers: ChatRequestSchema.shape.mcpServers,
})

// --- Generic error envelope -------------------------------------------------
// --- /api/tasks/schedules (recurring task runs) -----------------------------
// Step 7 of PLAN-agent-task-queue.md. A schedule row is a saved spec for
// a task plus a cron expression + IANA timezone; the tick walks due
// rows and enqueues a `start` job. See lib/server/agent/schedules.ts.

const CronExpressionSchema = z
  .string()
  .min(1)
  .max(100)
  // 5-field (minute hour dom month dow) — the cron-parser library
  // accepts more variants but pinning the shape here makes UI hints
  // and validation messages crisper. Use `*` for "every".
  .regex(
    /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/,
    "Cron must be 5 space-separated fields (e.g. '0 8 * * *')."
  )

export const ScheduleCreateSchema = z.object({
  workspaceId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  cron: CronExpressionSchema,
  /** IANA timezone identifier, e.g. "America/Los_Angeles". Defaults
   *  to UTC server-side. */
  timezone: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  /** Model id; falls back to the workspace's pinned model + global
   *  default when null. */
  model: z.string().max(100).nullable().optional(),
  systemPrompt: z.string().max(20_000).nullable().optional(),
  skills: ChatRequestSchema.shape.skills,
  maxSteps: z.number().int().min(1).max(50).nullable().optional(),
})

export const ScheduleUpdateSchema = ScheduleCreateSchema.partial()

export const ScheduleResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  prompt: z.string(),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  model: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  skills: ChatRequestSchema.shape.skills,
  maxSteps: z.number().nullable(),
  lastRunAt: z.string().nullable(),
  lastRunTaskId: z.string().nullable(),
  nextRunAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const ScheduleListResponseSchema = z.object({
  schedules: z.array(ScheduleResponseSchema),
})

// --- Generic error envelope -------------------------------------------------
// --- POST /api/images/refresh-url -------------------------------------------
//
// Re-sign an expired generated-image URL. The bytes live in Supabase
// Storage at `storagePath`; the route mints a fresh long-lived URL.

export const RefreshImageUrlRequestSchema = z.object({
  storagePath: z
    .string()
    .min(1)
    .max(512)
    // Defensive: the route also checks the first segment matches
    // auth.uid(), but reject obvious path-traversal attempts up front.
    .refine((p) => !p.includes(".."), "storagePath must not contain ..")
    .refine((p) => !p.startsWith("/"), "storagePath must not start with /"),
})

export const RefreshImageUrlResponseSchema = z.object({
  url: z.string().min(1),
})

// Non-streaming routes return `{ error, code?, message? }` with a non-2xx
// status on failure. Frontend categorisation lives in lib/api-errors.ts.

export const ErrorResponseSchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
})

// --- TS types (inferred from the schemas above) -----------------------------

export type ChatRequestInput = z.infer<typeof ChatRequestSchema>
export type TaskRequestInput = z.infer<typeof TaskRequestSchema>
export type RespondRequestInput = z.infer<typeof RespondRequestSchema>
export type TaskStartResponse = z.infer<typeof TaskStartResponseSchema>
export type RespondResponse = z.infer<typeof RespondResponseSchema>
export type ScheduleCreateInput = z.infer<typeof ScheduleCreateSchema>
export type ScheduleUpdateInput = z.infer<typeof ScheduleUpdateSchema>
export type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>
export type ScheduleListResponse = z.infer<typeof ScheduleListResponseSchema>
export type CompleteRequestInput = z.infer<typeof CompleteRequestSchema>
export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>
export type SummarizeRequestInput = z.infer<typeof SummarizeRequestSchema>
export type FileSummarizeResponse = z.infer<typeof FileSummarizeResponseSchema>
export type ConversationSummarizeResponse = z.infer<typeof ConversationSummarizeResponseSchema>
export type CompressSummarizeResponse = z.infer<typeof CompressSummarizeResponseSchema>
export type ProjectBreakdownResponse = z.infer<typeof ProjectBreakdownResponseSchema>
export type CreateShareRequestInput = z.infer<typeof CreateShareRequestSchema>
export type CreateShareResponse = z.infer<typeof CreateShareResponseSchema>
export type RefreshImageUrlRequestInput = z.infer<typeof RefreshImageUrlRequestSchema>
export type RefreshImageUrlResponse = z.infer<typeof RefreshImageUrlResponseSchema>
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
