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
}

export interface Note {
  id: string
  conversationId: string
  /** When set, the note is a bookmark anchored to a specific message. */
  messageId: string | null
  body: string
  createdAt: Date
  updatedAt: Date
}

export type ArtifactKind = 'code' | 'markdown' | 'json' | 'table' | 'image' | 'other'

export interface Artifact {
  id: string
  conversationId: string
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
