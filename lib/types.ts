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
  /** Detected/resolved content kind (e.g. 'pdf', 'docx', 'markdown'). */
  extractedKind?: string
}

export interface Workspace {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
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
