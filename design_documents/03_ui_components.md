# UI Components

This document details the main UI components used in the application, including ChatPanel, EditorPanel, SourcesPanel, and supporting components.

---

## 1. ChatPanel

### 1.1 Location

`components/panels/chat.tsx`

### 1.2 Purpose

The main chat interface that displays conversation messages and handles user input.

### 1.3 Features

- Two-column layout: messages on the left, **ResourcesSidebar** on the right (see §1.8). The right rail is collapsible; when collapsed it shrinks to an icon strip.
- Real AI streaming via `/api/chat` (SSE: `text` / `reasoning` / `error` / `done` / `suggestions` frames). Mock fallback when `AI_GATEWAY_API_KEY` is missing (`mockAIResponse` in `chat.tsx` — emits a fake reasoning block too).
- Assistant messages render via `<MarkdownPreview>` (GFM, tables, fenced code).
- **No avatars** — sender identity is alignment + bubble fill only.
- **User bubble** is a subtle tinted box (token `--user-bubble`); **assistant has no bubble** — prose flows directly on the page.
- Message column width: `max-w-[90%]`.
- Auto-scrolls the ScrollArea Viewport directly (not via `scrollIntoView`, which can scroll unintended ancestors).
- Typing indicator (no avatar) — three bouncing dots in a `--secondary` bubble.
- Reasoning / "Thinking…" surfacing via `<ReasoningBlock>` (see §1.6).

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

`components/panels/chat-message.tsx`. Asymmetric styling:

```tsx
<div className={cn("flex", isUser ? "flex-row-reverse" : "flex-row")}>
  <div className={cn(
    "flex flex-col max-w-[90%]",
    isUser ? "items-end" : "items-start"
  )}>
    <div className={cn(
      "animate-content-in w-full",
      isUser
        ? "rounded-lg px-4 py-2 bg-[var(--user-bubble)] text-[var(--user-bubble-foreground)]"
        : "text-[var(--foreground)]"
    )}>
      {!isUser && message.content
        ? <MarkdownPreview content={message.content} />
        : <p className="text-sm whitespace-pre-wrap">{message.content}</p>}
    </div>
  </div>
</div>
```

User: right-aligned, subtle tinted bubble. Assistant: left-aligned, no bg/padding/radius — markdown flows on the page background.

### 1.6 Reasoning block & typing indicator

`<ReasoningBlock>` renders when `message.reasoning` is non-empty. While streaming (`!message.content`), it shows a pulsing dot and "Thinking…"; once content arrives it switches to "Reasoning" + line count. Body uses `<MarkdownPreview>` with `max-h-[40vh] overflow-y-auto` so long thoughts don't dominate the message. Header has a hover-revealed copy button.

Typing indicator (no avatar):

```tsx
{isTyping && (
  <div className="flex">
    <div className="bg-[var(--secondary)] rounded-lg px-4 py-3">
      <div className="flex gap-1">
        <span className="w-2 h-2 bg-[var(--muted-foreground)] rounded-full animate-bounce" />
        <span className="w-2 h-2 bg-[var(--muted-foreground)] rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
        <span className="w-2 h-2 bg-[var(--muted-foreground)] rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
      </div>
    </div>
  </div>
)}
```

### 1.7 AI integration

Real path: `chat.tsx`'s `callChatAPI` POSTs to `/api/chat` and consumes typed SSE frames (`text` / `reasoning` / `error` / `done` / `suggestions`). Streamed tokens go through `appendToMessage` / `appendToMessageReasoning`; on `done` the placeholder is finalised and code blocks are auto-archived as artifacts (`autoArchiveCodeBlocks`).

Mock fallback: when `AI_GATEWAY_API_KEY` isn't set OR the server returns an `auth` error code, `mockAIResponse` (chat.tsx) fires instead:

```ts
const mockAIResponse = (userMessage: string) => {
  setIsTyping(true)
  setTimeout(() => {
    const reasoning = [
      `User asked: "${userMessage}".`,
      "Step 1 — Parse the request.",
      "Step 2 — Consider whether any state is relevant…",
      "Step 3 — Draft a reply that makes the mock origin obvious.",
    ].join("\n")
    const aiContent = `_Mock response (set \`AI_GATEWAY_API_KEY\` to enable real AI)_\n\nRegarding "${userMessage}": this is placeholder text.`
    addMessage({ role: "assistant", content: aiContent, reasoning })
    setIsTyping(false)
  }, 300)
}
```

The mock includes a fake reasoning blob so the `ReasoningBlock` UI is exercisable without a live reasoning-capable model.

### 1.8 ResourcesSidebar / ChatResourcesPanel

`components/sidebars/resources.tsx` (sidebar shell) wraps `components/panels/chat-resources-panel.tsx` (tab strip + body) as the chat view's right rail. Visible at `lg` breakpoint and above (`hidden lg:flex`); hidden on narrower viewports so the message column keeps its reading width. Toggle with `⌘⇧B` / `Ctrl+Shift+B`.

**Two modes:**
- **Expanded (`w-80`)** — header (title + collapse chevron `›`) above `ChatResourcesPanel`'s tab strip and body.
- **Collapsed (`w-12`)** — vertical icon rail: expand chevron `‹`, divider, then `Files / Notes / Artifacts` icons with count badges. Clicking an icon switches `resourcesSidebarTab` AND sets `resourcesSidebarOpen` to `true`.

Both `resourcesSidebarOpen` and `resourcesSidebarTab` live in the Zustand store (persisted). A first-mount sessionStorage marker flips the default to closed on `max-width: 768px` viewports — the user's later toggles always win.

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

Sidebar structure (top to bottom):

- **Header** — just the `SidebarTrigger` (collapse toggle), right-aligned. The profile / help / theme controls that used to live here moved to the footer (see below).
- **Content sections:**
  1. **Workspaces** (top-level `SidebarMenuButton`) — static label, click → `setActiveView('workspaces')`.
  2. **Editor** (top-level `SidebarMenuButton`) — click → `setActiveView('editor')`.
  3. **Resources** collapsible (Folder icon + label, hidden in icon-collapsed mode). One sub-item: **Files** → `setActiveView('resources')`. Inner `<SidebarGroup>` uses `p-0` so the header label aligns with the top-level icon column.
  4. **Chats** collapsible (MessagesSquare icon + label). Header has a `SidebarGroupAction` `+` button positioned at `right-8 top-1.5` (so it lines up with the chevron and sits between label and chevron). Click `+` → `createConversation()` + `setActiveView('chat')`. Conversation list via `useWorkspaceConversations()`. Click a row → `setActiveConversation(id)` + `setActiveView('chat')`. In icon-collapsed mode the conversation list flattens to icon-only buttons (Pin / MessageSquare).
- **Footer (`SidebarFooter`):** `AccountMenu` (flex-1) + `HelpPopover` + `ThemeToggle`. Help and Theme are hidden via `group-data-[collapsible=icon]:hidden` when the sidebar is icon-collapsed; `AccountMenu` remains visible (just the avatar icon).

Conversation items keep their pin / rename / delete actions via `ConversationItem`.

**Z-index note:** the `<Sidebar>` does NOT set a custom `z-index`. Popovers/dropdowns inside the sidebar (theme menu, account menu, conversation row menu) default to `z-50` and need to render above the sidebar; an earlier `className="z-100"` was removed because it pushed the sidebar above all popovers.

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
