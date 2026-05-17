# UI Components

This document details the main UI components used in the application, including ChatPanel, EditorPanel, SourcesPanel, and supporting components.

---

## 1. ChatPanel

### 1.1 Location

`components/panels/chat.tsx`

### 1.2 Purpose

The main chat interface that displays conversation messages and handles user input.

### 1.3 Features

- Two-column layout: messages on the left, **ChatResourcesPanel** on the right (see §1.8)
- Displays conversation messages with user/assistant roles
- Auto-scrolls to newest messages
- Typing indicator animation
- Message input with auto-resize textarea
- Syncs content to EditorPanel via store

The previous input-bar `SelectedFilesPopover` has been removed; file attachment now happens exclusively via the side panel's per-file toggle.

### 1.4 Components

#### MessageTime Component

Client-only time formatting to avoid hydration mismatch:

```typescript
function formatTime(timestamp: Date | string): string {
  const date = new Date(timestamp)
  const hours = date.getUTCHours()
  const minutes = date.getUTCMinutes()
  const ampm = hours >= 12 ? "PM" : "AM"
  const hour12 = hours % 12 || 12
  const minuteStr = minutes.toString().padStart(2, "0")
  return `${hour12}:${minuteStr} ${ampm}`
}

function MessageTime({ timestamp }: { timestamp: Date | string }) {
  const [time, setTime] = useState<string>("")

  useEffect(() => {
    setTime(formatTime(timestamp))
  }, [timestamp])

  if (!time) return null
  return <>{time}</>
}
```

### 1.5 Message Display

```typescript
<div className={cn(
  "flex gap-3",
  message.role === "user" ? "flex-row-reverse" : "flex-row"
)}>
  <Avatar className="w-8 h-8 mt-1">
    <AvatarFallback className="text-xs">
      {message.role === "user" ? <User size={16} /> : <Bot size={16} />}
    </AvatarFallback>
  </Avatar>
  <div className={cn(
    "max-w-[70%] rounded-lg px-4 py-2",
    message.role === "user"
      ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
      : "bg-[var(--secondary)] text-[var(--foreground)]"
  )}>
    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
  </div>
</div>
```

### 1.6 Typing Indicator

```typescript
{isTyping && (
  <div className="flex gap-3">
    <Avatar className="w-8 h-8 mt-1">
      <AvatarFallback className="text-xs">
        <Bot size={16} />
      </AvatarFallback>
    </Avatar>
    <div className="bg-[var(--secondary)] rounded-lg px-4 py-3">
      <div className="flex gap-1">
        <span className="w-2 h-2 bg-[var(--muted-foreground)] rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
        <span className="w-2 h-2 bg-[var(--muted-foreground)] rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
        <span className="w-2 h-2 bg-[var(--muted-foreground)] rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
      </div>
    </div>
  </div>
)}
```

### 1.7 AI Simulation (Mock)

```typescript
const simulateAIResponse = (userMessage: string) => {
  setIsTyping(true)
  setTimeout(() => {
    const responses = [
      "That's an interesting question! Let me think about it...",
      "I understand what you're asking. Here's my response:",
      "Thanks for sharing that! Based on what you've told me, I would say:",
      "That's a great point. Here's my take on it:",
      "I appreciate you asking! Here's what I think:",
    ]
    const randomResponse = responses[Math.floor(Math.random() * responses.length)]
    const additionalContent = `\n\nRegarding "${userMessage}": This is a mock response for testing purposes.`
    const aiContent = randomResponse + additionalContent
    addMessage({ role: "assistant", content: aiContent })
    setEditorContent(aiContent)
    setIsTyping(false)
  }, 300)
}
```

### 1.8 ChatResourcesPanel

`components/panels/chat-resources-panel.tsx` — a 320px-wide aside rendered as the second column of `ChatPanel`. Visible at `lg` breakpoint and above (`hidden lg:flex`); hidden on narrower viewports so the message column keeps its reading width.

**Purpose:** make workspace resources visible and attach/detach-able while chatting, without switching to the Resources main view.

**Data flow:**
- Reads workspace files via `useWorkspaceResources()`.
- Reads the **active conversation's** attachment selection via `useConversationSelectedFileIds()` (which resolves to `Conversation.selectedFileIds`). Each chat carries its own selection — switching conversations swaps the attached files.
- Toggles selection via `useStore.toggleConversationFileSelection(fileId)` (operates on the active conversation). The render rebinds whenever `activeConversationId` changes.
- Uploads via the same pattern as `SourcesPanel`: `processSelectedFiles` → `addFile` → `addResource(activeWorkspaceId, file.id)` → `toggleConversationFileSelection(file.id)` (uploaded file is auto-attached to the current chat only).

**UI sections (top → bottom):**
- Header: title "Files", line of small counters (`N in workspace · M attached`), `+` upload button.
- Search input (only shown when the workspace has resources).
- Scrollable list. Each row is a button: leading `Checkbox` (decorative, mirrors attached state), `getFileIcon`, filename, `formatFileSize` + upload date. Attached rows get `bg-primary/10 ring-1 ring-primary/40` and primary-colored filename; idle rows hover `bg-accent`. `aria-pressed` reflects attached state.
- Empty state when the workspace has zero resources: dashed drop-target inviting upload.
- "No files match …" when search filter yields zero.
- Footer: small "Manage workspace files →" link that calls `setActiveView('resources')`.

**Constraints used locally** (matching `SourcesPanel`): 5MB size limit and `.pdf,.docx,.txt,.csv,.json,.png,.jpg,.jpeg` extensions.

---

## 2. EditorPanel

### 2.1 Location

`components/panels/editor.tsx`

### 2.2 Technology

Plate.js (Slate-based rich text editor)

### 2.3 Setup

```typescript
import { Plate, PlateView, usePlateEditor } from "platejs/react"
import type { Value } from "platejs"
import type { MyEditor } from "@/components/third-party/plate/editor/editor-kit"
import { EditorKit } from "@/components/third-party/plate/editor/editor-kit"
import { Editor, EditorContainer } from "@/components/third-party/plate/ui/editor"

const defaultValue: Value = [
  {
    type: "h1",
    children: [{ text: "Chat Assistant Development Prompt" }],
  },
  {
    type: "p",
    children: [{ text: "Start a conversation in the chat panel to see messages appear here." }],
  },
]

export function EditorPanel({ initialContent }: EditorPanelProps) {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: defaultValue,
  })

  useEffect(() => {
    if (!editor || !initialContent) return
    updateEditorContent(editor, initialContent)
  }, [editor, initialContent])

  return (
    <div className="h-full w-full">
      <div className="h-full border-r-2">
        <Plate editor={editor}>
          <EditorContainer variant="default" className="h-[100vh]">
            <Editor />
          </EditorContainer>
        </Plate>
      </div>
    </div>
  )
}
```

### 2.4 Content Update

```typescript
function updateEditorContent(editor: MyEditor, content: string) {
  if (!content) return
  const nodes = editor.api.markdown.deserialize(content) as Value
  editor.tf.setValue(nodes)
}
```

---

## 3. SourcesPanel

### 3.1 Location

`components/panels/sources.tsx`

### 3.2 Features

- Drag-and-drop file upload
- File search/filter
- File selection with checkboxes
- Delete confirmation dialogs
- Hover cards for file details
- File type icons

### 3.3 File Validation

```typescript
const FILE_SIZE_LIMIT = 5 * 1024 * 1024 // 5MB

const ALLOWED_EXTENSIONS = [
  ".pdf", ".docx", ".txt", ".csv", ".json",
  ".png", ".jpg", ".jpeg"
]
```

### 3.4 Drag and Drop Handlers

```typescript
const handleDrop = useCallback((e: React.DragEvent) => {
  e.preventDefault()
  setIsDragOver(false)
  handleFileSelect(e.dataTransfer.files)
}, [handleFileSelect])

const handleDragOver = useCallback((e: React.DragEvent) => {
  e.preventDefault()
  setIsDragOver(true)
}, [])

const handleDragLeave = useCallback((e: React.DragEvent) => {
  e.preventDefault()
  setIsDragOver(false)
}, [])
```

---

## 5. Application Sidebar

### 5.1 Location

`components/sidebars/application.tsx`

### 5.2 Features

The AppSidebar drives a tabbed main area: clicking any tab calls `setActiveView(...)` and the dashboard's `MainArea` switches to the matching panel. There are **no sliding sidebars** mounted any longer — every panel is a main-area view.

Sidebar sections, top to bottom:

1. **Workspaces** (top-level `SidebarMenuButton`)
   - Static label `"Workspaces"` (the active workspace name no longer appears here — see `WorkspacesPanel` for workspace management).
   - Click switches the main area via `setActiveView('workspaces')`.
   - The previous workspace-switching popover (rename / delete / quick-switch) has been removed — those flows live in `WorkspacesPanel`.

2. **Editor** (top-level `SidebarMenuButton`)
   - Click switches the main area via `setActiveView('editor')`.

3. **Resources** (collapsible, hidden when sidebar is icon-collapsed)
   - Header is a `CollapsibleTrigger` (expand/collapse only).
   - Contains one sub-item:
     - **Files** — `setActiveView('resources')`.

4. **Chats** (collapsible, hidden when sidebar is icon-collapsed)
   - Header is a `CollapsibleTrigger`.
   - Header `SidebarGroupAction` `+` button calls `createConversation()` then `setActiveView('chat')`.
   - Lists workspace conversations via `useWorkspaceConversations()` — refreshes when the active workspace changes.
   - Clicking a conversation calls `setActiveConversation(id)` then `setActiveView('chat')`.
   - When the whole sidebar is icon-collapsed, the conversation list flattens to icon-only buttons (pinned conversations get the `Pin` icon, others get `MessageSquare`).

Conversation items keep their pin / rename / delete actions via `ConversationItem`.

### 5.3 Navigation Logic

The sidebar drives the main area through a single store action:

```typescript
setActiveView: (view: 'workspaces' | 'chat' | 'resources' | 'editor') => void
```

`MainArea` (in `app/dashboard/page.tsx`) reads `activeView` and renders exactly one of `WorkspacesPanel | ChatPanel | ResourcePanel | EditorPanel`. Switching is *single-target* — opening a new view replaces the current one. Selecting a chat is a two-step set: `setActiveConversation(id)` followed by `setActiveView('chat')`.

---

## 6. WorkspacesPanel (Main View)

### 6.1 Location

`components/panels/workspaces.tsx`

### 6.2 Purpose

Workspace overview rendered in the dashboard's main area (`SidebarInset`) when `activeView === 'workspaces'`. Acts as a hub for managing workspaces.

### 6.3 Features

- Responsive card grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`) — one card per workspace
- Each card shows: workspace name, `Active` badge, chat count, file count, created and updated dates
- Inline rename (Edit2 → Input → Check/X), with Enter to save and Esc to cancel
- Delete with `AlertDialog` confirmation (only when more than one workspace exists)
- Click anywhere on a non-editing card to set it active (`setActiveWorkspace`)
- Dashed "New Workspace" card at the end of the grid, plus a primary "+ New Workspace" button in the header

### 6.4 Data Sources

- `workspaces`, `activeWorkspaceId`, `setActiveWorkspace`, `createWorkspace`, `renameWorkspace`, `deleteWorkspace` from `useStore`
- `conversations` and `resources` from `useStore`, aggregated into per-workspace counts via `useMemo`

---

## 7. Related Documents

- [01_project_overview.md](01_project_overview.md) - Project foundation
- [02_state_management.md](02_state_management.md) - State management
- [04_ui_layout.md](04_ui_layout.md) - Layout system
