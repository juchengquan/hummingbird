export interface UploadedFile {
  id: string
  name: string
  size: number
  type: string
  uploadedAt: Date
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

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
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
}

export type MainView = 'workspaces' | 'chat' | 'resources' | 'editor'
