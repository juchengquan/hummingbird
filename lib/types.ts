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
}

export interface Resource {
  id: string
  workspaceId: string
  fileId: string
  addedAt: Date
}

export type MessageErrorCode =
  | 'auth'
  | 'rate_limit'
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
}

export interface ToolCallRecord {
  id: string
  name: string
  /** Short user-facing snippet from the input (e.g. the search query). */
  argsLabel?: string
  /** One-line result summary (e.g. "5 results" or "Search failed"). */
  summary?: string
}

export interface Conversation {
  id: string
  workspaceId: string
  title: string
  messages: Message[]
  createdAt: Date
  updatedAt: Date
  pinned: boolean
  /** Workspace file IDs attached as context for the next message in this conversation. */
  selectedFileIds: string[]
  /** Per-conversation editor document (rich-text scratchpad). */
  documentContent: string
  /**
   * Per-conversation skill overrides. Presence of a key = override
   * (true = on, false = off); absence = inherit from the workspace.
   */
  skillPrefs?: Record<string, boolean>
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

export type MainView = 'workspaces' | 'chat' | 'resources' | 'editor'
