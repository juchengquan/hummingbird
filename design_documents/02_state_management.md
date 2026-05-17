# State Management

This document details the state management approach using Zustand, including store structure, actions, and persistence configuration.

---

## 1. Overview

The application uses **Zustand** for global state management with localStorage persistence. It consists of two stores:

1. **Main Store (`useStore`)**: Persistent state across sessions
2. **Session Store (`useSessionStore`)**: Temporary state for current session

---

## 2. Main Store (`useStore`)

### 2.1 Location

`lib/hooks/use-store.ts`

### 2.2 TypeScript Interfaces

```typescript
interface UploadedFile {
  id: string
  name: string
  size: number
  type: string
  uploadedAt: Date
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

interface Conversation {
  id: string
  workspaceId: string
  title: string
  messages: Message[]
  createdAt: Date
  updatedAt: Date
  pinned: boolean
  /** Workspace file IDs attached as context for this conversation's next message. */
  selectedFileIds: string[]
}

interface Workspace {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
}

interface Resource {
  id: string
  workspaceId: string
  fileId: string
  addedAt: Date
}

type Theme = 'system' | 'dark' | 'light'
```

### 2.3 Store State Structure

| State | Type | Default | Description |
|-------|------|---------|-------------|
| theme | `'system' \| 'dark' \| 'light'` | `'dark'` | Application theme |
| activeView | `'workspaces' \| 'chat' \| 'resources' \| 'editor'` | `'workspaces'` | Single source of truth for which panel renders in the main area (`SidebarInset`). Tabs in the sidebar set this. |
| sidebarCollapsed | boolean | false | Main sidebar collapsed state |
| files | UploadedFile[] | [] | Uploaded files array |
| workspaces | Workspace[] | [default workspace] | All workspaces |
| activeWorkspaceId | string | 'default' | Active workspace ID |
| resources | Resource[] | [] | File-to-workspace associations |
| conversations | Conversation[] | [demo conversation] | All conversations (grouped by workspaceId) |
| activeConversationId | string | 'demo-1' | Active conversation ID |
| isTyping | boolean | false | AI typing indicator |
| streamingContent | string | '' | Streaming response content |
| documentContent | string | '' | Document content |
| documentLastSaved | Date \| null | null | Last saved timestamp |
| editorContent | string | '' | Editor content synced from chat |

### 2.4 Store Actions

#### View / Sidebar Actions

```typescript
toggleSidebar: () => void                                   // toggles sidebarCollapsed
setActiveView: (view: MainView) => void                     // drives MainArea
```

All legacy per-panel boolean toggles (`toggleChatPanel`, `toggleEditorPanel`, `toggleResourcesPanel`, `toggleSourcesPanel`, `toggleChatSessionsPanel`, `toggleWorkspacePanel`), the `openPanel` group-routing action, and the panel-width setters have been removed — the dashboard is tabbed and stores no individual panel-open state.

#### Workspace Actions

```typescript
createWorkspace: (name: string) => Workspace
deleteWorkspace: (workspaceId: string) => void
renameWorkspace: (workspaceId: string, name: string) => void
setActiveWorkspace: (workspaceId: string) => void
```

#### Resource Actions

```typescript
addResource: (workspaceId: string, fileId: string) => void
removeResource: (resourceId: string) => void
getWorkspaceResources: (workspaceId: string) => Resource[]
```

#### File Actions

```typescript
addFile: (file: UploadedFile) => void
removeFile: (fileId: string) => void
clearFiles: () => void
```

There are now **two distinct file-selection concepts**, kept apart on purpose:

- **Chat-attachment selection** — which workspace files are attached as context for the *next message* in a specific conversation. Stored as `selectedFileIds: string[]` on the `Conversation` entity itself, so it persists with the conversation and is independent per chat (switching chats reveals each chat's own attachments). Mutated via the conversation actions below. `removeFile(id)` also strips that id from every conversation's `selectedFileIds`.
- **Resources view bulk selection** — the checkboxes inside `SourcesPanel` used for bulk delete/clear actions. Still lives on `useSessionStore` (sessionStorage-backed, session-scoped, not per-conversation). Unrelated to chat attachment.

#### Conversation Actions

```typescript
createConversation: (workspaceId?: string) => Conversation
deleteConversation: (conversationId: string) => void
renameConversation: (conversationId: string, title: string) => void
togglePin: (conversationId: string) => void
setActiveConversation: (conversationId: string | null) => void
// File attachment for the active conversation:
toggleConversationFileSelection: (fileId: string) => void
clearConversationFileSelection: () => void
```

The helper selector `useConversationSelectedFileIds(): string[]` returns the active conversation's `selectedFileIds` (or `[]` when nothing is active).

#### Message Actions

```typescript
addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => Message
deleteMessage: (messageId: string) => void
updateMessage: (messageId: string, content: string) => void
clearMessages: () => void
setIsTyping: (typing: boolean) => void
setStreamingContent: (content: string) => void
```

#### Document Actions

```typescript
setDocumentContent: (content: string) => void
setDocumentLastSaved: (date: Date) => void
setEditorContent: (content: string) => void
```

#### Theme Actions

```typescript
setTheme: (theme: Theme) => void
toggleTheme: () => void  // Cycles: system -> dark -> light -> system
```

---

## 3. Persistence Configuration

### 3.1 Storage Key

```typescript
name: 'hummingbird-storage'
```

### 3.2 Persisted State

Only specific state is persisted to localStorage:

```typescript
{
  theme: state.theme,
  activeView: state.activeView,
  workspaces: state.workspaces,
  activeWorkspaceId: state.activeWorkspaceId,
  resources: state.resources,
  conversations: state.conversations,
  activeConversationId: state.activeConversationId,
  files: state.files,
  documentContent: state.documentContent,
}
```

### 3.3 Hydration Callback

```typescript
onRehydrateStorage: () => () => {
  hasHydratedInternal = true
}
```

### 3.4 Persist Version & Migration

The persist config sets `version: 3`.

- `fromVersion < 2`: strip dead keys from the old multi-panel layout (boolean panel flags, panel widths, the top-level `selectedFileIds`).
- `fromVersion < 3`: per-chat attachment selection. `selectedFileIds` moved from `useSessionStore` onto each `Conversation`. The migration backfills `selectedFileIds: []` on any persisted conversation missing the field.

```typescript
version: 3,
migrate: (persistedState, fromVersion) => {
  if (!persistedState || typeof persistedState !== 'object') return persistedState
  const state = persistedState as Record<string, unknown>
  if (fromVersion < 2) {
    const stale = [
      'chatPanelOpen','editorPanelOpen','resourcesPanelOpen','sourcesPanelOpen',
      'chatSessionsPanelOpen','workspacePanelOpen',
      'chatSessionsPanelWidth','resourcesPanelWidth','editorPanelWidth',
      'selectedFileIds',
    ]
    for (const k of stale) delete state[k]
  }
  if (fromVersion < 3) {
    const convs = state.conversations
    if (Array.isArray(convs)) {
      state.conversations = convs.map((c) =>
        c && typeof c === 'object' && !('selectedFileIds' in c)
          ? { ...c, selectedFileIds: [] }
          : c
      )
    }
  }
  return persistedState
}
```

---

## 4. Session Store (`useSessionStore`)

### 4.1 Purpose

Handles temporary state that should be cleared when the browser tab is closed.

### 4.2 Storage

Uses **sessionStorage** instead of localStorage:

```typescript
{
  name: 'hummingbird-session',
  storage: createJSONStorage(() => sessionStorage)
}
```

### 4.3 State

```typescript
selectedFileIds: string[]  // Bulk-selection inside SourcesPanel only — session-scoped
```

> Chat-attachment selection lives on `Conversation.selectedFileIds`, **not** here. Don't reuse `useSessionStore.selectedFileIds` for chat — see §2.4 Conversation Actions.

### 4.4 Actions

```typescript
toggleFileSelection: (fileId: string) => void
setSelectedFileIds: (ids: string[]) => void
clearSelectedFiles: () => void
```

---

## 5. Hydration Handling

### 5.1 Problem

Next.js uses Server-Side Rendering (SSR), which can cause hydration mismatches when using localStorage data.

### 5.2 Solution

Custom `useHydrated` hook:

```typescript
let hasHydratedInternal = false

export const useHydrated = () => {
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(hasHydratedInternal)
  }, [])

  return hydrated
}
```

### 5.3 Usage

Components that depend on persisted state should check hydration:

```typescript
const hydrated = useHydrated()

if (!hydrated) {
  return (
    <div className="flex items-center justify-center h-full">
      <p>Loading...</p>
    </div>
  )
}
```

---

## 6. Theme Initialization

### 6.1 Synchronous Read

Theme is read synchronously to prevent flash:

```typescript
function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'

  try {
    const stored = localStorage.getItem('hummingbird-storage')
    if (stored) {
      const parsed = JSON.parse(stored)
      return parsed.state?.theme || 'dark'
    }
  } catch {}

  return 'dark'
}
```

### 6.2 Default Value

Dark theme is the default to match server-side render.

---

## 7. Helper Selectors

### 7.1 useActiveWorkspace

Returns the currently active workspace object:

```typescript
export const useActiveWorkspace = () => {
  const workspaces = useStore((state) => state.workspaces)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return workspaces.find((w) => w.id === activeWorkspaceId) || null
}
```

### 7.2 useActiveConversation

Returns the currently active conversation object:

```typescript
export const useActiveConversation = () => {
  const conversations = useStore((state) => state.conversations)
  const activeConversationId = useStore((state) => state.activeConversationId)
  return conversations.find((c) => c.id === activeConversationId) || null
}
```

### 7.3 useWorkspaceConversations

Returns all conversations for the active workspace:

```typescript
export const useWorkspaceConversations = () => {
  const conversations = useStore((state) => state.conversations)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return conversations.filter((c) => c.workspaceId === activeWorkspaceId)
}
```

### 7.4 useWorkspaceResources

Returns all resources (files) for the active workspace:

```typescript
export const useWorkspaceResources = () => {
  const resources = useStore((state) => state.resources)
  const files = useStore((state) => state.files)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  const workspaceResources = resources.filter((r) => r.workspaceId === activeWorkspaceId)
  return workspaceResources.map((r) => files.find((f) => f.id === r.fileId)).filter(Boolean)
}
```

### 7.5 useConversationSelectedFileIds

Returns the active conversation's chat-attachment selection (file IDs). Empty array when no conversation is active.

```typescript
export const useConversationSelectedFileIds = (): string[] => {
  const conv = useActiveConversation()
  return conv?.selectedFileIds ?? []
}
```

---

## 8. Default Data

### 8.1 Default Workspace

The store initializes with a default workspace:

```typescript
const getDefaultWorkspaces = (): Workspace[] => {
  const now = new Date('2024-01-01T12:00:00Z')
  return [
    {
      id: 'default',
      name: 'My Workspace',
      createdAt: now,
      updatedAt: now,
    },
  ]
}
```

### 8.2 Default Resources

No resources are added by default.

### 8.3 Demo Conversation

The store initializes with a demo conversation in the default workspace:

```typescript
const getDefaultConversations = (): Conversation[] => {
  const baseTime = new Date('2024-01-01T12:00:00Z').getTime()
  return [
    {
      id: 'demo-1',
      workspaceId: 'default',
      title: 'Welcome Chat',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: 'Hello! I am your AI assistant. How can I help you today?',
          timestamp: new Date(baseTime - 60000),
        },
        {
          id: 'msg-2',
          role: 'user',
          content: 'Hi! I am testing the chat panel. It looks great!',
          timestamp: new Date(baseTime - 30000),
        },
        {
          id: 'msg-3',
          role: 'assistant',
          content: 'Thank you! Feel free to ask me anything or start a new conversation.',
          timestamp: new Date(baseTime),
        },
      ],
      createdAt: new Date(baseTime - 120000),
      updatedAt: new Date(baseTime),
      pinned: true,
    },
  ]
}
```

---

## 9. Data Relationships

### 9.1 Entity Relationship Diagram

```
┌─────────────┐       ┌─────────────────┐       ┌─────────────┐
│  Workspace   │ 1 ─── *│   Conversation   │       │    File     │
│             │       │                 │       │             │
│ - id        │       │ - id            │       │ - id        │
│ - name      │       │ - workspaceId   │       │ - name      │
│ - createdAt │       │ - title         │       │ - size      │
│ - updatedAt │       │ - messages      │       │ - type      │
└─────────────┘       │ - createdAt     │       │ - uploadedAt│
                      │ - updatedAt     │       └─────────────┘
                      │ - pinned        │              │
                      └─────────────────┘              │
                                                       │ 1
                                                       ▼
                      ┌─────────────────┐       ┌─────────────┐
                      │    Resource     │       │   (Join)    │
                      │                 │       │             │
                      │ - id            │       └─────────────┘
                      │ - workspaceId   │
                      │ - fileId        │
                      │ - addedAt       │
                      └─────────────────┘
```

### 9.2 Relationship Rules

1. **Workspace → Conversations**: One workspace can have multiple conversations
2. **Workspace → Resources**: One workspace can have multiple file resources
3. **Conversation → Workspace**: Each conversation belongs to exactly one workspace
4. **Resource → Workspace**: Each resource belongs to exactly one workspace
5. **Resource → File**: Each resource references one file (fileId)

---

## 10. Related Documents

- [01_project_overview.md](01_project_overview.md) - Project foundation
- [03_ui_components.md](03_ui_components.md) - UI components
- [04_ui_layout.md](04_ui_layout.md) - Layout system
