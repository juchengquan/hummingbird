export type FileExtractionStatus = 'pending' | 'done' | 'failed' | 'unsupported'

export interface UploadedFile {
  id: string
  name: string
  size: number
  type: string
  uploadedAt: Date
  /** Lifecycle of the text-extraction pipeline. Absent on legacy files (treated as 'done' with no text). */
  extractionStatus?: FileExtractionStatus
  /** Extracted plain text content. May be truncated; see `extractionTruncated`. */
  extractedText?: string
  /** True when `extractedText` was cut to fit the per-file budget. */
  extractionTruncated?: boolean
  /** Full extracted text (up to FULL_EXTRACTION_BUDGET ≈ 1 MB). Only
   *  set when distinct from `extractedText` — i.e. when the file's
   *  raw text exceeded the inline budget. Used by the Phase 3
   *  `readFileSection` tool; persists to `files.full_text` via the
   *  sync reconcile path. See `docs/PLAN-file-full-text-retrieval.md`. */
  extractedFullText?: string
  /** Detected/resolved content kind (e.g. 'pdf', 'docx', 'markdown', 'image'). */
  extractedKind?: string
  /**
   * For image uploads, the base64 data URL read client-side at upload time.
   * Sent to vision-capable models as a multimodal content part. Lives in
   * localStorage today; will migrate to Supabase Storage when the sync
   * layer lands.
   */
  imageDataUrl?: string
  /**
   * Auto-generated 2-3 sentence summary of the extracted text. Only populated
   * when extraction succeeded and produced enough content to summarise.
   */
  summary?: string
  /**
   * Short topic phrases the summariser identified in the file. Surfaced
   * inline in the file row for at-a-glance "what is this?" understanding.
   */
  keyTopics?: string[]
  /**
   * Path inside the `user-files` Supabase Storage bucket — e.g.
   * `{user_id}/{file_id}.pdf`. Absent when the blob lives only locally
   * (IndexedDB) or in UploadThing.
   */
  storagePath?: string
  /**
   * Soft-delete marker. When set, the file is considered removed by
   * every UI listing and the chat-route payload builder, but the
   * metadata stub (`id, name, size, type, uploadedAt, deletedAt`) is
   * retained so durable references — message `attachedFileIds`,
   * future structured citations, notes anchored to a deleted file —
   * can resolve to "🗑 name (removed)" instead of crashing or
   * silently showing nothing.
   *
   * At tombstone time the *content-ish* fields are freed:
   * `extractedText`, `imageDataUrl`, `storagePath`, the IndexedDB
   * blob, and (best-effort) the Supabase Storage object. Only the
   * lightweight metadata remains in `files[]`.
   */
  deletedAt?: Date
}

export interface Workspace {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
  /**
   * Optional per-workspace system prompt prepended to every chat in this
   * workspace. Lets the user give a workspace a persona / role / style
   * without setting it again per conversation.
   */
  systemPrompt?: string
  /**
   * Optional pinned default chat model for this workspace. When set,
   * switching into this workspace auto-applies the model (until the user
   * picks a different one via the chat-input model picker, which sticks
   * until the next workspace switch). Empty / undefined = no preference,
   * falls back to the global `DEFAULT_CHAT_MODEL`.
   */
  defaultModel?: string
  /**
   * Workspace-level skill defaults. Each conversation in this workspace
   * inherits these unless it sets its own override. Absent keys fall back
   * to the skill's hard-coded default (see lib/skills/registry.ts).
   */
  skillPrefs?: Record<string, boolean>
  /**
   * Workspace-level config for the `webSearch` skill — per-turn cap +
   * per-provider toggles + per-provider knobs (Tavily search depth,
   * Brave freshness, …). Conversations inherit field-by-field and can
   * override any single leaf. See `resolveWebSearchConfig` in
   * `lib/shared/skills/web-search-config.ts`. Field-by-field cascade
   * means a workspace can set `tavily.searchDepth = 'advanced'` while a
   * conversation toggles `brave.enabled = false` without either erasing
   * the other.
   */
  webSearchConfig?: import("./skills/web-search-config").WebSearchConfig
  /**
   * Workspace-level config for the `webFetch` skill — just a per-turn
   * cap today, but the cascade machinery is in place for future knobs.
   * Conversations inherit and can override.
   */
  webFetchConfig?: import("./skills/web-fetch-config").WebFetchConfig
  /**
   * Workspace-level config for the `imageGen` skill (Minimax image
   * generation). Per-turn cap + default aspect ratio today; cascade
   * machinery is shared with the other skills.
   */
  imageGenConfig?: import("./skills/image-gen-config").ImageGenConfig
  /**
   * Workspace-level config for the `searchFiles` skill — just a per-turn
   * cap today. Same cascade pattern as `webFetchConfig`.
   */
  fileSearchConfig?: import("./skills/file-search-config").FileSearchConfig
  /**
   * Project mode (see `docs/PLAN-project-mode.md`). When true, the
   * workspace becomes a "project": the workspace detail sheet reveals
   * the goal + milestones fields and the right rail gains a Tasks
   * (Kanban) tab. Default/undefined = a plain folder workspace.
   */
  isProject?: boolean
  /** Free-text objective for the project. Only meaningful when
   *  `isProject`. Drives the "break this down into tasks" AI action. */
  goal?: string
  /** Optional milestone list for the project. Inert until the board /
   *  progress UI lands; carried here so the schema + sync are complete. */
  milestones?: Milestone[]
  /**
   * User-defined ordering within the workspaces list, set by
   * `reorderWorkspaces`. The drag-and-drop UI in the Workspaces panel
   * writes monotonically increasing integers; the render order falls
   * back to insertion order when `position` is undefined (legacy rows
   * before the field was introduced).
   */
  position?: number
  /**
   * Spatial-canvas layout for this workspace — node positions +
   * connections + viewport. Node *bodies* are projected from the live
   * store (messages / artifacts / notes / files / bookmarks) at render
   * time; only layout lives here. Undefined until the user adds the
   * first node. See `lib/shared/canvas/types.ts` and the Workspace
   * canvas plan.
   */
  canvasState?: import("./canvas/types").CanvasState
}

/** A single project milestone. `dueDate` is an ISO date string when
 *  set. Stored as a jsonb array on the workspace row. */
export interface Milestone {
  title: string
  dueDate?: string
}

/** Kanban column a project task sits in. Mirrors the
 *  `project_tasks.status` CHECK in migration `0014`. */
export type ProjectTaskStatus = "todo" | "in_progress" | "done" | "cancelled"

/**
 * A Kanban card in a project workspace (see `docs/PLAN-project-mode.md`).
 * The card is the durable to-do; `taskId` optionally links it to a
 * long-running run that executes it, and `artifactId` to the
 * deliverable that run produced. A card with neither is a manual
 * to-do.
 */
export interface ProjectTask {
  id: string
  workspaceId: string
  title: string
  status: ProjectTaskStatus
  /** Order within the (workspace, status) column. */
  position: number
  /** The long-running task run this card spawned, if any. */
  taskId?: string
  /** The artifact the run produced, if any. */
  artifactId?: string
  createdAt: Date
  updatedAt: Date
}

/**
 * Rich-text document inside a workspace. A workspace owns N documents;
 * one is "active" at a time (top-level `activeDocumentId` in the store).
 * Plate editor reads and writes `content`; "Send to editor" actions
 * append to the active document, creating one if none exists yet.
 */
export interface Document {
  id: string
  workspaceId: string
  title: string
  /** Markdown text. Empty string is the initial state. */
  content: string
  /** User-defined ordering within a workspace's doc list. Defaults to
   *  insertion order when undefined. */
  position?: number
  createdAt: Date
  updatedAt: Date
}

export interface Resource {
  id: string
  workspaceId: string
  fileId: string
  addedAt: Date
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) — workspace-scoped server bindings + the
// data they expose. Mirrors the files / resources / conversationFiles
// triple: a server owns N resources; resources can be attached to a
// workspace library (`McpResourceBinding`) and/or pinned privately to
// one conversation (`ConversationMcpResource`).
//
// Stage 1 carries the type + store shape; Stages 2-3 wire the proxy
// route, capability discovery, and tool/resource injection into the
// chat route. See `docs/PLAN-mcp-integration.md`.
// ---------------------------------------------------------------------------

export type McpTransport = 'http'

/** Where the server's credential lives. */
export type McpCredentialMode = 'cloud' | 'local'

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  /** MCP Apps (ext-apps): the `ui://` resource this tool renders an
   *  interactive panel from, captured from the tool's
   *  `_meta.ui.resourceUri` at discovery. Absent for ordinary tools —
   *  the whole MCP-Apps path is a no-op unless a tool declares this. See
   *  `docs/PLAN-mcp-apps.md`. */
  uiResourceUri?: string
}

export interface McpResourceDescriptor {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpPromptDescriptor {
  name: string
  description?: string
}

export interface McpCapabilities {
  tools?: McpToolDescriptor[]
  resources?: McpResourceDescriptor[]
  prompts?: McpPromptDescriptor[]
}

/** A rendered MCP App — bundled HTML read from a tool's `ui://` resource,
 *  shown in a sandboxed iframe inline with the assistant message. Phase 1
 *  is read-only render; phase 2 added the tool-call bridge; phase 3 added
 *  the refresh affordance + an explicit "too large" stub. See
 *  `docs/PLAN-mcp-apps.md`. */
export interface McpAppPart {
  /** Stable id (the producing tool call id when available). */
  id: string
  /** The MCP server that produced the app. Pins the tool-call bridge
   *  to a single server. */
  serverId: string
  /** Bundled HTML/JS read from the tool's `ui://` resource. */
  html: string
  /** The original `ui://` resource URI the HTML was read from. Set
   *  on emits from phase 3 onward — enables the refresh button to
   *  re-`read` the resource through `/api/mcp/:id/read` and replace
   *  `html`. Absent on parts persisted from earlier phases; the
   *  refresh button hides itself in that case. */
  resourceUri?: string
  /** `true` when the server truncated the HTML because it exceeded
   *  the per-app size cap. The renderer shows an explicit "UI too
   *  large" stub instead of trusting the (small placeholder) HTML.
   *  Absent / `false` on normal-size apps. */
  truncated?: boolean
}

export interface McpServer {
  id: string
  workspaceId: string
  /** User-facing label (e.g. "GitHub", "Notion personal"). */
  name: string
  /** MCP endpoint URL. */
  url: string
  transport: McpTransport
  credentialMode: McpCredentialMode
  /**
   * For `credentialMode === 'local'`: a stable hash of the local
   * credential (so two devices can tell when they have different creds
   * for the "same" server config). Not the cred itself — that lives in
   * `localStorage` keyed by server id. Absent for `cloud` mode.
   */
  credentialFingerprint?: string
  /** Server-reported capabilities, cached from the last discovery. */
  capabilities?: McpCapabilities
  capabilitiesFetchedAt?: Date
  /** Soft-disable without removing the row. */
  enabled: boolean
  /** Server-side policy: when true, every tool this server exposes is
   *  HITL-gated in agent tasks regardless of the client's
   *  requireApprovalFor. Cloud-mode only. Absent = false. */
  requiresApproval?: boolean
  createdAt: Date
  updatedAt: Date
  /** Soft-delete marker (same pattern as UploadedFile.deletedAt). */
  deletedAt?: Date
}

/** A resource exposed by an MCP server — cached pointer, not content. */
export interface McpResource {
  id: string
  workspaceId: string
  serverId: string
  /** Stable URI on the MCP server (the addressing primitive). */
  uri: string
  /** Cached display name from discovery. */
  name: string
  description?: string
  mimeType?: string
  addedAt: Date
  deletedAt?: Date
}

/** Workspace-library lane for MCP resources (parallel to `Resource`). */
export interface McpResourceBinding {
  id: string
  workspaceId: string
  resourceId: string
  addedAt: Date
}

/** Conversation-private lane (parallel to `ConversationFile`). */
export interface ConversationMcpResource {
  id: string
  conversationId: string
  resourceId: string
  addedAt: Date
}

// ---------------------------------------------------------------------------
// URL bookmarks — saved web pages. Third source type after files and
// MCP resources, sharing the same workspace-library + conversation-
// private lane model. Content is fetched + extracted server-side at
// save time and cached in `content`; manual refresh re-fetches and
// updates `fetchedAt` + `contentHash`.
//
// See `docs/PLAN-url-bookmarks.md` for the design.
// ---------------------------------------------------------------------------

export interface UrlBookmark {
  id: string
  workspaceId: string
  /** Canonical URL (post-normalization). */
  url: string
  /** Extracted from `<title>`, fallback to hostname. */
  title: string
  /** Extracted plain text from the page body, capped at the server-side
   *  budget (currently 200 KB). */
  content: string
  /** True when extraction hit the per-bookmark cap. */
  contentTruncated: boolean
  /** Wall-clock timestamp of the most recent successful fetch. */
  fetchedAt: Date
  /** SHA-256 of `content` — lets the UI show "no changes since last
   *  fetch" diffs without re-comparing the full text. */
  contentHash: string
  /** Site's `<meta name="description">` or first paragraph snippet. */
  description?: string
  /** Absolute URL of the site favicon. Best-effort; absent when the
   *  site doesn't expose one. */
  faviconUrl?: string
  /** Soft-delete marker (matches UploadedFile.deletedAt). */
  deletedAt?: Date
  createdAt: Date
  updatedAt: Date
}

/** Conversation-private lane (parallel to `ConversationFile` and
 *  `ConversationMcpResource`). */
export interface ConversationUrlBookmark {
  id: string
  conversationId: string
  bookmarkId: string
  addedAt: Date
}

/**
 * Conversation-private file attachment. Parallel to `Resource` but
 * scoped to a single conversation — these files do **not** appear in
 * the workspace library and are not visible to sibling conversations.
 *
 * The chat-route payload sends the union of (workspace files ticked
 * via `Conversation.selectedFileIds`) + (private files attached via
 * this join). De-duped by `fileId` so a file referenced by both lanes
 * is only sent once.
 */
export interface ConversationFile {
  id: string
  conversationId: string
  fileId: string
  addedAt: Date
}

export type MessageErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'context_window'
  | 'invalid_model'
  | 'provider'
  | 'network'
  | 'unknown'

export interface MessageError {
  code: MessageErrorCode
  status?: number
  model?: string
  detail?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  /** When set on an assistant message, render the error bubble UI instead of plain content. */
  error?: MessageError
  /**
   * Reasoning / "thinking" tokens streamed from models that emit them
   * (DeepSeek R1, Claude thinking variants, etc.). Rendered in a collapsible
   * section above the main content. Not included in exports or Copy.
   */
  reasoning?: string
  /**
   * Wall-clock duration in ms between the first and last reasoning chunk.
   * Used to render a "Thought for X.Xs" badge in the collapsed
   * `ReasoningBlock` header. Survives reload because it's persisted on
   * the message — without it the badge would only show during the live
   * stream.
   */
  reasoningDurationMs?: number
  /**
   * Durable record of every tool the model invoked while producing this
   * message — web search queries, code execution, image gen, etc. Each
   * entry has a stable id, the tool name, a short summary (e.g. "5
   * results"), and an optional input snippet (e.g. the search query).
   *
   * Lives on the message because:
   *   1. The chat panel's transient `liveToolCalls` state clears on
   *      stream `done`, so we'd lose the indicator on reload.
   *   2. The previous "markdown footer" approach polluted the message
   *      text and didn't render as a pill.
   *
   * Empty array is omitted on the wire / persistence.
   */
  toolCalls?: ToolCallRecord[]
  /**
   * Snapshot of which workspace files were attached when this message was
   * sent. Lives on the message (not the conversation) so the visual record
   * survives later changes to the conversation's selection or file deletion.
   * For deleted files we keep the id and render a "deleted attachment"
   * placeholder.
   */
  attachedFileIds?: string[]
  /**
   * Model-generated follow-up question prompts. Surfaced as click-to-send
   * chips below the most recent assistant message. Cleared on regenerate
   * or edit-and-resend.
   */
  suggestions?: string[]
  /**
   * Citation-verification result for this turn — per-claim grounding
   * verdicts (supported / partial / unsupported) + a confidence summary.
   * Present only when verification ran (opt-in / Deep Research) and found
   * cited claims. Drives the inline unsupported-claim markers + the
   * per-message confidence chip. See `docs/PLAN-citation-verifiability.md`.
   */
  verification?: import("./verify").VerificationResult
  /**
   * Images the model generated during this turn via the `imageGen`
   * skill. Each entry carries the rendered image URL (Supabase Storage
   * signed URL when available; data: URL fallback when storage isn't
   * configured), dimensions when known, and the prompt that produced
   * it. Rendered as a gallery beneath the assistant text in PR C.
   * Empty / undefined when no images were generated.
   */
  generatedImages?: GeneratedImage[]
  /**
   * Generative-UI parts produced by the `renderUI` tool — an inline
   * structured component (info-table in v1) rendered alongside the
   * assistant text. Each entry is a `PersistedUiPart` (`id`, `kind`,
   * validated `props`, optional `answeredAt`). Empty / undefined when
   * the assistant didn't render any structured content this turn. See
   * `docs/PLAN-generative-ui-parts.md`.
   */
  uiParts?: import("./generative-ui/schemas").PersistedUiPart[]
  /**
   * When this turn was sent with the "Auto" model option, the concrete
   * model the smart router resolved to (e.g. `anthropic/claude-haiku-4.5`).
   * Rendered as a small "Auto → <label>" caption on the assistant bubble
   * so routing is transparent. Absent for explicit (non-Auto) model picks.
   * See `docs/PLAN-model-routing.md`.
   */
  routedModel?: string
  /**
   * Interactive panels produced by MCP Apps — an MCP tool that declares
   * a `ui://` resource renders bundled HTML in a sandboxed iframe inline
   * with the assistant text. Each entry carries the read HTML + the
   * producing server id. Persisted so it survives reload. Absent unless a
   * tool used the MCP-Apps extension. See `docs/PLAN-mcp-apps.md`.
   */
  mcpApps?: McpAppPart[]
  /**
   * Excluded from the chat API request when true. Set by the "Compress
   * older messages" action — the message stays on disk and renders
   * (muted, behind a "Show N compressed" disclosure on the recap card)
   * but the model no longer sees it. Cleared by Undo on the
   * corresponding recap.
   */
  compressed?: boolean
  /**
   * Marks special synthetic messages. `'recap'` is a model-generated
   * summary inserted in place of compressed messages — rendered with
   * a distinct card and an Undo affordance. Regular user / assistant
   * messages leave this undefined.
   */
  kind?: 'recap'
  /**
   * Only meaningful on `kind: 'recap'` messages — the original message
   * ids that this recap stands in for. Undo iterates this list to flip
   * `compressed` back to false; deleting the recap entry restores the
   * original conversation.
   */
  recapMessageIds?: string[]
}

export interface GeneratedImage {
  /** Stable per-image id — used as the React key and as the storage
   *  object name when persisted to Supabase. */
  id: string
  /** Hosted URL the UI loads. Either:
   *  - Supabase Storage signed URL (durable but expires; UI re-signs
   *    lazily on render — same pattern as conversation files), OR
   *  - `data:image/png;base64,...` URL when Supabase isn't configured
   *    or upload failed. Heavier on persistence but works for
   *    signed-out / offline users. */
  url: string
  /** Set when the image was persisted to Supabase Storage. Lets the
   *  client re-sign a fresh URL from the same bytes if the original
   *  ever expires. Undefined for data-URL fallbacks. */
  storagePath?: string
  /** Width in pixels. Zero is a sentinel "unknown — let the browser
   *  detect from the loaded image." Set when the upstream provider
   *  returns dimensions; left at 0 otherwise. */
  width: number
  height: number
  /** Lowercase MIME subtype (`"png"`, `"jpg"`, `"webp"`). */
  format: string
  /** The prompt the model passed to `generateImage`, kept for the
   *  alt text + the lightbox caption + any "regenerate this" affordance
   *  PR C may add. */
  prompt: string
  /** Which mode produced the image. `"i2i"` ones may want different
   *  affordances (e.g. "use the reference again" rather than "regenerate"). */
  mode: 't2i' | 'i2i'
}

export interface ToolCallRecord {
  id: string
  name: string
  /** Short user-facing snippet from the input (e.g. the search query). */
  argsLabel?: string
  /** One-line result summary (e.g. "5 results" or "Search failed"). */
  summary?: string
  /** Detailed result entries (currently only populated for `webSearch`).
   *  Surfaced as the Sources strip + clickable `[N]` citation markers in
   *  the rendered assistant message. Optional + backward-compatible —
   *  legacy persisted rows without this field continue to render fine. */
  results?: ToolCallResult[]
}

export interface ToolCallResult {
  title: string
  url: string
  snippet: string
}

/**
 * Pinned explanation produced by the selection-driven Explain action.
 * Stored in session-only state (not persisted to localStorage or
 * Supabase) — pins survive view changes within a session but vanish
 * on reload, by design. Scoped to a conversation so switching
 * conversations swaps the visible pins.
 */
export interface PinnedExplanation {
  id: string
  conversationId: string
  /** The selected passage that was explained. Stored as-is for the
   *  card header; truncate at render time. */
  selection: string
  /** The model's full streamed answer (markdown). */
  content: string
  /** Model id used to produce the explanation, e.g. "anthropic/claude-sonnet-4-6". */
  model: string
  /** Tool-call results captured during the explain stream (currently
   *  webSearch only). Renders the Sources strip inside the pin card. */
  results?: ToolCallResult[]
  createdAt: number
}

export interface Conversation {
  id: string
  workspaceId: string
  title: string
  messages: Message[]
  createdAt: Date
  updatedAt: Date
  pinned: boolean
  /** Per-thread system-prompt tier in the chat cascade — the slot
   *  documented in `lib/shared/agents/resolve.ts` between the
   *  workspace voice and the per-turn persona override. Empty
   *  string when unset (no inheritance from the workspace). See
   *  `docs/PLAN-conversation-system-prompt.md`. */
  systemPrompt: string
  /** Workspace file IDs attached as context for the next message in this conversation. */
  selectedFileIds: string[]
  /** Per-attached-file retrieval mode override. Absence of an entry =
   *  default ("inline" — file's extracted text is in the system
   *  prompt). `"rag"` = the file is NOT inlined, only retrievable via
   *  the `searchFiles` skill. Maps file id → mode. Only `"rag"` is
   *  worth persisting; setting back to inline clears the key. Empty
   *  map on conversations created before v23. See
   *  `docs/PLAN-cross-product-inspirations.md` item #6. */
  fileRetrievalModes?: Record<string, "rag">
  /** Workspace MCP-resource IDs (`McpResource.id`, not URIs) ticked on
   *  for this conversation. Empty array on conversations created before
   *  v17 — backfilled defensively. */
  selectedMcpResourceIds?: string[]
  /** Workspace URL-bookmark IDs ticked on for this conversation.
   *  Empty / absent on conversations created before v18. */
  selectedUrlBookmarkIds?: string[]
  /** Artifact IDs ticked on for this conversation. */
  selectedArtifactIds?: string[]
  /**
   * Per-conversation skill overrides. Presence of a key = override
   * (true = on, false = off); absence = inherit from the workspace.
   */
  skillPrefs?: Record<string, boolean>
  /**
   * Per-conversation override of any `webSearch` config field —
   * per-turn cap, per-provider enable, per-provider knobs. Resolved
   * field-by-field against `Workspace.webSearchConfig` and the
   * built-in defaults.
   */
  webSearchConfig?: import("./skills/web-search-config").WebSearchConfig
  /**
   * Per-conversation override of the workspace `webFetch` config. Same
   * field-by-field cascade as `webSearchConfig`.
   */
  webFetchConfig?: import("./skills/web-fetch-config").WebFetchConfig
  /**
   * Per-conversation override of the workspace `imageGen` config. Same
   * field-by-field cascade as the other skills.
   */
  imageGenConfig?: import("./skills/image-gen-config").ImageGenConfig
  /**
   * Per-conversation override of the workspace `searchFiles` config.
   * Same field-by-field cascade as `webFetchConfig`.
   */
  fileSearchConfig?: import("./skills/file-search-config").FileSearchConfig
  /**
   * Conversation this one was forked from. Set by `forkConversation`;
   * undefined for top-of-tree chats. Used by the branches dialog to
   * render the fork tree.
   */
  parentId?: string
  /** Message in the parent where the fork was made — the "branch point". */
  forkedFromMessageId?: string
}

export interface Note {
  id: string
  /** Notes are scoped to the workspace — they survive conversation
   *  deletion (with `conversationId` cleared) so they remain a long-lived
   *  knowledge surface for the workspace. */
  workspaceId: string
  /** Source conversation the note was created in. Null when the source
   *  conversation has been deleted or the note was created outside any
   *  conversation. */
  conversationId: string | null
  /** When set, the note is a bookmark anchored to a specific message in
   *  the source conversation. Bookmarks are deleted when their source
   *  conversation is deleted (the anchor message no longer exists). */
  messageId: string | null
  body: string
  createdAt: Date
  updatedAt: Date
}

export type ArtifactKind = 'code' | 'markdown' | 'json' | 'table' | 'image' | 'other'

export interface Artifact {
  id: string
  /** Artifacts are scoped to the workspace — they outlive the conversation
   *  they were saved from. */
  workspaceId: string
  /** Source conversation. Null when the conversation has been deleted. */
  conversationId: string | null
  /** Set when the artifact was extracted from a specific assistant message. Nullable: artifacts can outlive their source. */
  messageId: string | null
  kind: ArtifactKind
  /** For code artifacts, the fence info (e.g. 'tsx', 'python'). */
  language: string | null
  /** User-editable display title. Auto-generated on save. */
  title: string
  /** Inline text content (code, markdown, json, table CSV). */
  content: string
  /** For binary artifacts (images). Null for text. */
  storagePath: string | null
  pinned: boolean
  createdAt: Date
}

/**
 * User-scoped saved prompt template. Lives in the left sidebar's
 * Prompts group; click-to-insert into the chat input expands the
 * `{variable}` markers via the variable-fill modal. See
 * `docs/_done/PLAN-prompt-library.md`.
 *
 * Phase 1 stores prompts in Zustand only (per-device, no sync).
 * Phase 2 will add a Supabase `prompts` table + the standard
 * `diffPrompts` sync handler. The shape below is forward-compatible
 * with that (matches the planned column set; `slug` derives from
 * `name` and stays editable independently).
 */
export interface Prompt {
  id: string
  /** Workspace this prompt belongs to. Scoped like conversations — switching
   *  workspaces shows only that workspace's prompts. */
  workspaceId: string
  /** User-facing label. Slug derives from this on first save. */
  name: string
  /** Identifier for the future `/<slug>` slash trigger. Derived from
   *  `name` on creation, then editable independently. */
  slug: string
  /** Plain text with `{variable}` markers — see
   *  `lib/shared/prompts/expand.ts`. */
  template: string
  /** Variable names in first-appearance order, derived from `template`
   *  at save time and stored for quick listing without re-parsing. */
  variables: string[]
  createdAt: Date
  updatedAt: Date
  /** Soft-delete marker. Same pattern as `files.deletedAt` etc. so the
   *  Phase 2 sync handler can ship tombstones without UI special-casing. */
  deletedAt?: Date
}

/**
 * Custom agent / persona — `PLAN-custom-agents.md`. A saved bundle of
 * { name, system prompt, model, allowed skills, allowed MCP servers }
 * the user invokes via `/<slug>` in the chat input. Same workspace-
 * scoped + soft-delete + sync pattern as `Prompt`.
 */
export interface Agent {
  id: string
  /** Workspace this persona belongs to. */
  workspaceId: string
  /** User-facing label. */
  name: string
  /** Slash trigger token, derived from `name` on creation. Unique per
   *  (workspace, !deletedAt). */
  slug: string
  /** Free-text system prompt. Appended after the workspace's own
   *  `systemPrompt` when the persona is active. Empty string is fine —
   *  signals "model + skills only, no prompt reshape." */
  systemPrompt: string
  /** Optional model override. Falls back to workspace `defaultModel` →
   *  global `DEFAULT_CHAT_MODEL` when unset. */
  modelId?: string
  /** Skills force-enabled when this persona is active. Explicit list, no
   *  cascade inheritance — the user picks exactly which skills are
   *  available. */
  allowedSkillIds: string[]
  /** MCP server ids (cloud-mode) the persona is allowed to call. Empty
   *  array = no MCP for this persona; present = only those servers.
   *  Enforced server-side in `loadEffectiveMcpServers`. (Phase 2.) */
  allowedMcpServerIds: string[]
  /** Optional Lucide icon name. UI defaults to a generic icon. */
  icon?: string
  /** Sticky at the top of the sidebar listing. */
  pinned?: boolean
  createdAt: Date
  updatedAt: Date
  /** Soft-delete marker — same convention as other sync'd entities. */
  deletedAt?: Date
}

export type MainView =
  | 'workspaces'
  | 'chat'
  | 'resources'
  | 'editor'
  | 'canvas'
  /** Cross-conversation index of every generated image + artifact in
   *  the active workspace. Click → open the source conversation /
   *  artifact. Read-only — produced by joining the existing
   *  `Message.generatedImages` + `Artifact` rows; no new store state. */
  | 'library'
