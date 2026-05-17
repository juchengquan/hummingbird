# Chat Assistant Development Prompt - Detailed Implementation Guide

## Project Overview

This document provides a comprehensive, detailed implementation guide for building the Chat Assistant application (Humm). It captures the current state of implementation and serves as a blueprint for reproducing and extending the application.

---

## 1. Project Foundation

### 1.1 Technology Stack

The application is built with the following core technologies:

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| Runtime | Bun | Latest | JavaScript runtime and package manager |
| Framework | Next.js | 16.1.6 | React framework with App Router |
| Language | TypeScript | 5.x | Type-safe JavaScript |
| UI Library | React | 19.2.3 | Component-based UI library |
| State Management | Zustand | 5.0.11 | Lightweight state management with persistence |
| Styling | Tailwind CSS | 4 | Utility-first CSS framework |
| Icons | Lucide React | 0.564.0 | Icon library |
| Rich Text Editor | Plate.js | 0.123.0 | Rich text editing |
| UI Components | Radix UI + Shadcn | Various | Accessible UI primitives |
| AI SDK | @ai-sdk/react | 3.0.92 | AI integration |
| Date Handling | date-fns | 4.1.0 | Date formatting |

### 1.2 Project Structure

```
humm/
├── app/                          # Next.js App Router
│   ├── layout.tsx                # Root layout with Geist fonts
│   ├── page.tsx                  # Root redirect to dashboard
│   ├── globals.css               # Global CSS variables and styles
│   ├── favicon.ico               # App favicon
│   └── dashboard/
│       └── page.tsx              # Main dashboard with sidebar layout
│
├── components/
│   ├── ui/                       # Base UI components
│   │   ├── button.tsx            # Button with variants
│   │   ├── input-group.tsx       # Input group components
│   │   ├── sidebar.tsx           # Shadcn sidebar
│   │   ├── scroll-area.tsx      # Radix scroll area
│   │   ├── resizable.tsx        # Resizable panels
│   │   ├── popover.tsx          # Popover component
│   │   ├── avatar.tsx            # Avatar component
│   │   ├── checkbox.tsx          # Checkbox component
│   │   ├── hover-card.tsx        # Hover card
│   │   ├── alert-dialog.tsx      # Alert dialog
│   │   ├── item.tsx              # Item components
│   │   ├── collapsible.tsx       # Collapsible component
│   │   └── custom/               # Custom UI variants
│   │       └── scrollbar.tsx     # Custom scrollbar
│   │
│   ├── panels/                   # Main content panels
│   │   ├── chat.tsx             # Chat interface panel
│   │   ├── editor.tsx           # Plate.js rich text editor
│   │   ├── sources.tsx          # File management panel
│   │   └── markdown-to-slate-demo.tsx  # Markdown demo component
│   │
│   ├── sidebars/                # Sidebar components
│   │   ├── application.tsx      # Main app navigation sidebar
│   │   ├── chat-sidebar.tsx     # Chat panel wrapper
│   │   ├── editor-sidebar.tsx   # Editor panel wrapper
│   │   ├── sources-sidebar.tsx  # Sources panel wrapper
│   │   └── sliding-sidebar.tsx  # Reusable sliding sidebar
│   │
│   ├── third-party/
│   │   └── plate/               # Plate.js editor setup
│   │       ├── editor/
│   │       │   └── editor-kit.tsx
│   │       └── ui/
│   │           └── editor.tsx
│   │
│   └── panel-container.tsx      # Panel wrapper component
│
├── lib/
│   ├── hooks/
│   │   └── use-store.ts         # Zustand store with persistence
│   ├── file-utils.tsx           # File handling utilities
│   └── utils.ts                 # cn() utility for Tailwind
│
├── layout/
│   └── conversation-item.tsx    # Conversation list item
│
├── public/                      # Static assets
│
├── package.json                  # Dependencies
├── tsconfig.json                # TypeScript config
├── next.config.ts               # Next.js config
├── tailwind.config.ts           # Tailwind config
└── postcss.config.mjs           # PostCSS config
```

---

## 2. Core Implementation Details

### 2.1 State Management (Zustand Store)

The application uses **Zustand** for global state management with localStorage persistence.

#### Main Store: `useStore`

**Location**: `lib/hooks/use-store.ts`

**Key Interfaces**:

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
  title: string
  messages: Message[]
  createdAt: Date
  updatedAt: Date
  pinned: boolean
}

type Theme = 'system' | 'dark' | 'light'
```

**Store State Structure**:

| State | Type | Default | Description |
|-------|------|---------|-------------|
| theme | `'system' \| 'dark' \| 'light'` | `'dark'` | Application theme |
| chatSessionsPanelOpen | boolean | true | Chat sessions sidebar visibility |
| resourcesPanelOpen | boolean | true | Resources sidebar visibility |
| sourcesPanelOpen | boolean | false | Sources panel visibility |
| chatPanelOpen | boolean | true | Chat panel visibility |
| editorPanelOpen | boolean | true | Editor panel visibility |
| sidebarCollapsed | boolean | false | Main sidebar collapsed state |
| chatSessionsPanelWidth | number | 280 | Chat sessions panel width |
| resourcesPanelWidth | number | 280 | Resources panel width |
| editorPanelWidth | number | 480 | Editor panel width |
| files | UploadedFile[] | [] | Uploaded files array |
| selectedFileIds | string[] | [] | Selected file IDs |
| conversations | Conversation[] | [demo conversation] | All conversations |
| activeConversationId | string | 'demo-1' | Active conversation ID |
| isTyping | boolean | false | AI typing indicator |
| streamingContent | string | '' | Streaming response content |
| documentContent | string | '' | Document content |
| documentLastSaved | Date \| null | null | Last saved timestamp |
| editorContent | string | '' | Editor content from chat |

**Key Store Actions**:

```typescript
// Panel actions
toggleSidebar: () => void
toggleChatSessionsPanel: () => void
toggleResourcesPanel: () => void
toggleSourcesPanel: () => void
toggleChatPanel: () => void
toggleEditorPanel: () => void
openPanel: (panelName: keyof Pick<AppState, 'chatPanelOpen' | 'editorPanelOpen' | 'sourcesPanelOpen'>, group?: string) => void
setChatSessionsPanelWidth: (width: number) => void
setResourcesPanelWidth: (width: number) => void
setEditorPanelWidth: (width: number) => void

// File actions
addFile: (file: UploadedFile) => void
removeFile: (fileId: string) => void
toggleFileSelection: (fileId: string) => void
clearSelectedFiles: () => void
clearFiles: () => void

// Conversation actions
createConversation: () => void
deleteConversation: (conversationId: string) => void
renameConversation: (conversationId: string, title: string) => void
togglePin: (conversationId: string) => void
setActiveConversation: (conversationId: string | null) => void

// Message actions
addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => Message
deleteMessage: (messageId: string) => void
updateMessage: (messageId: string, content: string) => void
clearMessages: () => void
setIsTyping: (typing: boolean) => void
setStreamingContent: (content: string) => void

// Document actions
setDocumentContent: (content: string) => void
setDocumentLastSaved: (date: Date) => void
setEditorContent: (content: string) => void

// Theme actions
setTheme: (theme: Theme) => void
toggleTheme: () => void
```

**Persistence Configuration**:

```typescript
{
  name: 'hummingbird-storage',
  onRehydrateStorage: () => () => {
    hasHydratedInternal = true
  },
  partialize: (state) => ({
    theme: state.theme,
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    files: state.files,
    documentContent: state.documentContent,
    chatSessionsPanelOpen: state.chatSessionsPanelOpen,
    resourcesPanelOpen: state.resourcesPanelOpen,
    sourcesPanelOpen: state.sourcesPanelOpen,
    chatPanelOpen: state.chatPanelOpen,
    editorPanelOpen: state.editorPanelOpen,
    chatSessionsPanelWidth: state.chatSessionsPanelWidth,
    resourcesPanelWidth: state.resourcesPanelWidth,
    editorPanelWidth: state.editorPanelWidth,
  })
}
```

**Theme Initialization (Synchronous to prevent flash)**:

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

#### Session Store: `useSessionStore`

A separate store for session-based state that uses sessionStorage:

```typescript
{
  name: 'hummingbird-session',
  storage: createJSONStorage(() => sessionStorage)
}
```

**Session State**:
- `selectedFileIds: string[]` - Files selected for current session only
- `toggleFileSelection: (fileId: string) => void`
- `setSelectedFileIds: (ids: string[]) => void`
- `clearSelectedFiles: () => void`

#### Hydration Handling

Custom hook for SSR/client synchronization:

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

#### Helper Selectors

```typescript
export const useActiveConversation = () => {
  const conversations = useStore((state) => state.conversations)
  const activeConversationId = useStore((state) => state.activeConversationId)
  return conversations.find((c) => c.id === activeConversationId) || null
}

export const useSelectedFiles = () => {
  const files = useStore((state) => state.files)
  const selectedFileIds = useStore((state) => state.selectedFileIds)
  return files.filter((f) => selectedFileIds.includes(f.id))
}
```

---

### 2.2 Layout Architecture

#### Root Layout (`app/layout.tsx`)

```typescript
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
```

**Features**:
- Uses Geist font (Google Fonts)
- `suppressHydrationWarning` for hydration mismatch handling

#### Dashboard Page (`app/dashboard/page.tsx`)

```typescript
export default function Page() {
  return (
    <div className="h-screen overflow-hidden">
      <SidebarProvider>
        <AppSidebar />
        <ChatSidebar />
        <SourcesSidebar />
        <EditorSidebar />
      </SidebarProvider>
    </div>
  )
}
```

**Panel System**:
- Uses Shadcn UI `SidebarProvider` for state management
- Four sliding sidebars: AppSidebar (left navigation), ChatSidebar, SourcesSidebar, EditorSidebar

---

### 2.3 UI Components

#### ChatPanel (`components/panels/chat.tsx`)

**Features**:
- Displays conversation messages with user/assistant roles
- Auto-scrolls to newest messages
- Typing indicator animation
- Message input with auto-resize textarea
- SelectedFilesPopover for file attachments
- Syncs content to EditorPanel via store

**Key Components**:

1. **MessageTime**: Client-only time formatting to avoid hydration mismatch

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

2. **SelectedFilesPopover**: File selection popover with upload capability

```typescript
function SelectedFilesPopover() {
  const addFile = useStore((state) => state.addFile)
  const files = useStore((state) => state.files)
  const toggleSourcesPanel = useStore((state) => state.toggleSourcesPanel)
  const { selectedFileIds, toggleFileSelection } = useSessionStore()
  const selectedFiles = files.filter((f) => selectedFileIds.includes(f.id))
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = processSelectedFiles(e.target.files)
    uploadedFiles.forEach((file) => {
      addFile(file)
      toggleFileSelection(file.id)
    })
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <InputGroupButton size="icon-sm" className="rounded-full">
          <Files size={20} />
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-72 p-2">
        {/* File list and upload buttons */}
      </PopoverContent>
    </Popover>
  )
}
```

3. **ChatPanel**: Main chat interface

**Message Display**:
- Avatar for user/assistant
- Role-based styling (user: primary color, assistant: secondary)
- Timestamp display
- Message animations with staggered delays

```typescript
<div
  className={cn(
    "flex gap-3",
    message.role === "user" ? "flex-row-reverse" : "flex-row"
  )}
>
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

**Typing Indicator**:

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

**AI Simulation (Mock)**:

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

#### EditorPanel (`components/panels/editor.tsx`)

**Technology**: Plate.js (Slate-based rich text editor)

**Setup**:

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

**Content Update**:

```typescript
function updateEditorContent(editor: MyEditor, content: string) {
  if (!content) return
  const nodes = editor.api.markdown.deserialize(content) as Value
  editor.tf.setValue(nodes)
}
```

#### SourcesPanel (`components/panels/sources.tsx`)

**Features**:
- Drag-and-drop file upload
- File search/filter
- File selection with checkboxes
- Delete confirmation dialogs
- Hover cards for file details
- File type icons

**File Validation**:

```typescript
const FILE_SIZE_LIMIT = 5 * 1024 * 1024 // 5MB

const ALLOWED_EXTENSIONS = [
  ".pdf", ".docx", ".txt", ".csv", ".json",
  ".png", ".jpg", ".jpeg"
]
```

**Drag and Drop Handler**:

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

#### SlidingSidebar (`components/sidebars/sliding-sidebar.tsx`)

**Props Interface**:

```typescript
interface SlidingSidebarProps {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
  closeButtonIcon: React.ReactNode
  closeButtonLabel: string
  className?: string
  width?: string | number
}
```

**Features**:
- Animated slide-in/out from right
- Offset calculation based on left sidebar state
- Keeps content mounted after first open
- CSS animations: `animate-slide-in-right`, `animate-slide-out-right`

#### Application Sidebar (`components/sidebars/application.tsx`)

**Features**:
- Collapsible icon sidebar (Shadcn UI)
- Navigation buttons: Sources, Chat, Editor
- Sessions list with collapsible section
- Conversation items with pin, rename, delete actions

**Navigation Logic**:

```typescript
const openPanel = (panelName, group = "sliding") => {
  const panelStates = {
    chatPanelOpen: "chatPanelOpen",
    editorPanelOpen: "editorPanelOpen",
    sourcesPanelOpen: "sourcesPanelOpen",
  }
  const panelGroup = {
    chatPanelOpen: "sliding",
    editorPanelOpen: "sliding",
    sourcesPanelOpen: "sliding",
  }

  const newState = {}

  // Close all panels in the same group
  Object.entries(panelGroup).forEach(([panel, g]) => {
    if (g === group && panel !== panelName) {
      newState[panel as keyof AppState] = false
    }
  })

  // Toggle the target panel
  const targetPanel = panelStates[panelName]
  if (targetPanel) {
    newState[targetPanel] = !(state[targetPanel as keyof AppState] as boolean)
  }

  return newState
}
```

---

### 2.4 Utility Functions

#### File Utils (`lib/file-utils.tsx`)

```typescript
interface UploadedFile {
  id: string
  name: string
  size: number
  type: string
  uploadedAt: Date
}

// Process files from FileList
processSelectedFiles(files: FileList, options?: {
  maxSize?: number
  onValidationError?: (error: string) => void
}): UploadedFile[]

// Get file icon based on MIME type
getFileIcon(type: string): React.ReactNode

// Format file size
formatFileSize(bytes: number): string
```

**Implementation**:

```typescript
export function processSelectedFiles(
  files: FileList | null,
  options: {
    maxSize?: number
    onValidationError?: (error: string) => void
  } = {}
): UploadedFile[] {
  if (!files) return []

  const { maxSize = 5 * 1024 * 1024, onValidationError } = options
  const uploadedFiles: UploadedFile[] = []

  Array.from(files).forEach((file) => {
    if (file.size > maxSize) {
      onValidationError?.(`File "${file.name}" exceeds ${formatFileSize(maxSize)} limit`)
      return
    }

    uploadedFiles.push({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type,
      uploadedAt: new Date(),
    })
  })

  return uploadedFiles
}

export function getFileIcon(type: string): React.ReactNode {
  if (type.includes('pdf')) return <FileText className="text-red-500" size={20} />
  if (type.includes('word') || type.includes('document')) return <FileText className="text-blue-500" size={20} />
  if (type.includes('image')) return <Image className="text-purple-500" size={20} />
  if (type.includes('json')) return <FileJson className="text-yellow-500" size={20} />
  if (type.includes('csv') || type.includes('text')) return <FileText className="text-green-500" size={20} />
  return <File className="text-gray-500" size={20} />
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
```

#### CN Utility (`lib/utils.ts`)

```typescript
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

---

### 2.5 CSS Design System

#### Global Variables (`app/globals.css`)

The application uses CSS custom properties for theming:

```css
:root {
  --background: #ffffff;
  --foreground: #171717;
  --card: #ffffff;
  --card-foreground: #171717;
  --primary: #000000;
  --primary-foreground: #ffffff;
  --secondary: #f5f5f5;
  --secondary-foreground: #171717;
  --muted: #f5f5f5;
  --muted-foreground: #737373;
  --accent: #f5f5f5;
  --accent-foreground: #171717;
  --destructive: #ef4444;
  --destructive-foreground: #fafafa;
  --border: #e5e5e5;
  --input: #e5e5e5;
  --ring: #171717;
  --radius: 0.5rem;
}

.dark {
  --background: #0a0a0a;
  --foreground: #ededed;
  --card: #1a1a1a;
  --card-foreground: #ededed;
  --primary: #ededed;
  --primary-foreground: #171717;
  --secondary: #262626;
  --secondary-foreground: #ededed;
  --muted: #262626;
  --muted-foreground: #a3a3a3;
  --accent: #262626;
  --accent-foreground: #ededed;
  --destructive: #ef4444;
  --destructive-foreground: #fafafa;
  --border: #262626;
  --input: #262626;
  --ring: #d4d4d4;
}
```

---

## 2.6 UI Layout System

The application uses a multi-panel sliding sidebar layout system. The UI is built on Shadcn UI components with custom sliding panel implementations.

### 2.6.1 Layout Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      AppSidebar (Left)                      │
│  ┌─────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │  Logo   │  │  Navigation  │  │    Sessions List     │  │
│  │  + New  │  │ Sources/Chat │  │  (Collapsible)      │  │
│  │ Session │  │   /Editor    │  │  - Conversation 1   │  │
│  └─────────┘  └──────────────┘  │  - Conversation 2   │  │
│                                  │  - Conversation 3   │  │
│                                  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │
         │ (Sliding Sidebars from right)
         ▼
┌─────────────────────────────────────────────────────────────┐
│  SourcesPanel  │  ChatPanel  │  EditorPanel                 │
│  (Files/       │  (Messages  │  (Plate.js                  │
│   Resources)   │   + Input)  │   Editor)                   │
└─────────────────────────────────────────────────────────────┘
```

### 2.6.2 Sidebar Provider (`SidebarProvider`)

**Location**: `components/ui/sidebar.tsx`

The `SidebarProvider` provides context for all sidebar components and manages the collapsed/expanded state.

```typescript
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar"

// Usage
<SidebarProvider defaultOpen={true}>
  <AppSidebar />
  <ChatSidebar />
  <SourcesSidebar />
  <EditorSidebar />
</SidebarProvider>
```

**Context Values**:
```typescript
interface SidebarContextProps {
  state: "expanded" | "collapsed"  // Current sidebar state
  open: boolean                      // Whether sidebar is open
  setOpen: (open: boolean) => void  // Function to set open state
  isMobile: boolean                 // Whether device is mobile
  openMobile: boolean               // Mobile sidebar state
  setOpenMobile: (open: boolean) => void
  toggleSidebar: () => void         // Toggle function
}
```

**Configuration Constants**:
```typescript
const SIDEBAR_COOKIE_NAME = "sidebar_state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7  // 7 days
const SIDEBAR_WIDTH = "16rem"        // 256px
const SIDEBAR_WIDTH_MOBILE = "18rem"  // 288px
const SIDEBAR_WIDTH_ICON = "3rem"     // 48px
const SIDEBAR_KEYBOARD_SHORTCUT = "b" // Cmd/Ctrl + B to toggle
```

### 2.6.3 SlidingSidebar Component

**Location**: `components/sidebars/sliding-sidebar.tsx`

A custom component that creates sliding panels that animate in from the right side of the screen.

**Props Interface**:
```typescript
interface SlidingSidebarProps {
  isOpen: boolean           // Control open/close state
  onClose: () => void      // Callback when sidebar should close
  children: React.ReactNode
  closeButtonIcon: React.ReactNode
  closeButtonLabel: string
  className?: string
  width?: string | number  // Custom width (default: full viewport minus sidebar)
}
```

**Key Features**:
1. **Offset Calculation**: Automatically calculates left position based on main sidebar state
2. **Animation**: Uses CSS animations for smooth slide-in/slide-out
3. **Visibility State**: Keeps content mounted after first open (for editor performance)
4. **Hydration Safety**: Prevents SSR hydration mismatch

**Implementation**:
```typescript
const SIDEBAR_EXPANDED_WIDTH = 256  // 16rem
const SIDEBAR_COLLAPSED_WIDTH = 48   // 3rem

export function SlidingSidebar({
  isOpen,
  onClose,
  children,
  closeButtonIcon,
  closeButtonLabel,
  className = "",
  width,
}: SlidingSidebarProps) {
  const { state: sidebarState } = useSidebar()
  const [mounted, setMounted] = React.useState(false)
  const [isVisible, setIsVisible] = React.useState(false)

  // Calculate sidebar offset based on collapsed state
  const sidebarWidth = mounted && sidebarState === "collapsed"
    ? SIDEBAR_COLLAPSED_WIDTH
    : SIDEBAR_EXPANDED_WIDTH

  return (
    <div
      className={`
        fixed top-0 h-full z-50
        border-l border-[var(--border)]
        bg-[var(--background)]
        ${mounted ? (isOpen ? "animate-slide-in-right" : "animate-slide-out-right") : ""}
        ${className}
      `}
      style={{
        left: `${sidebarWidth}px`,
        width: width ?? `calc(100vw - ${sidebarWidth}px)`,
      }}
    >
      {/* Header with close button */}
      <div className="flex items-center justify-end p-1 border-b border-[var(--border)]">
        <button onClick={onClose} aria-label={closeButtonLabel}>
          {closeButtonIcon}
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  )
}
```

### 2.6.4 Resizable Panels (`ResizablePanelGroup`)

**Location**: `components/ui/resizable.tsx`

Uses `react-resizable-panels` for draggable panel resizing.

**Components**:
```typescript
// Main container
<ResizablePanelGroup orientation="horizontal">
  <ResizablePanel defaultSize={20} minSize={15} maxSize={40}>
    <FirstPanel />
  </ResizablePanel>

  <ResizableHandle withHandle />

  <ResizablePanel defaultSize={40} minSize={20} maxSize={50}>
    <SecondPanel />
  </ResizablePanel>

  <ResizableHandle withHandle />

  <ResizablePanel defaultSize={40}>
    <ThirdPanel />
  </ResizablePanel>
</ResizablePanelGroup>
```

**API**:
| Component | Props | Description |
|-----------|-------|-------------|
| `ResizablePanelGroup` | `orientation`, `className` | Container for panels |
| `ResizablePanel` | `defaultSize`, `minSize`, `maxSize`, `children` | Individual panel |
| `ResizableHandle` | `withHandle`, `className` | Drag handle between panels |

### 2.6.5 Sidebar Components

**Application Sidebar** (`components/sidebars/application.tsx`):

The main navigation sidebar with collapsible icon mode.

```typescript
<Sidebar collapsible="icon">
  <SidebarHeader>
    <SidebarTrigger />
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="New Session" onClick={createConversation}>
          <Plus />
          <span>New Session</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="Sources" onClick={() => openPanel("sourcesPanelOpen")}>
          <Files />
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="Chat" onClick={() => openPanel("chatPanelOpen")}>
          <MessageSquare />
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="Editor" onClick={() => openPanel("editorPanelOpen")}>
          <PencilLine />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  </SidebarHeader>

  <SidebarContent>
    <SidebarGroup>
      <SidebarGroupLabel>Sessions</SidebarGroupLabel>
      <SidebarMenu>
        {conversations.map(conv => (
          <SidebarMenuItem key={conv.id}>
            <ConversationItem conversation={conv} />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  </SidebarContent>

  <SidebarRail />
</Sidebar>
```

**Sidebar Variants**:

| Variant | Description |
|---------|-------------|
| `sidebar` | Default sidebar with border |
| `floating` | Floating sidebar with rounded corners and shadow |
| `inset` | Inset sidebar for use inside other containers |

**Collapsible Modes**:

| Mode | Behavior |
|------|----------|
| `offcanvas` | Slides out of view completely |
| `icon` | Collapses to icon-only mode |
| `none` | Always shows full width |

### 2.6.6 Panel Sidebar Wrappers

Each sliding panel has a corresponding wrapper component:

**ChatSidebar** (`components/sidebars/chat-sidebar.tsx`):
```typescript
export function ChatSidebar() {
  const chatPanelOpen = useStore(state => state.chatPanelOpen)
  const toggleChatPanel = useStore(state => state.toggleChatPanel)

  return (
    <SlidingSidebar
      isOpen={chatPanelOpen}
      onClose={toggleChatPanel}
      closeButtonIcon={<ChevronRight />}
      closeButtonLabel="Close chat"
    >
      <ChatPanel />
    </SlidingSidebar>
  )
}
```

**SourcesSidebar** (`components/sidebars/sources-sidebar.tsx`):
```typescript
export function SourcesSidebar() {
  const sourcesPanelOpen = useStore(state => state.sourcesPanelOpen)
  const toggleSourcesPanel = useStore(state => state.toggleSourcesPanel)

  return (
    <SlidingSidebar
      isOpen={sourcesPanelOpen}
      onClose={toggleSourcesPanel}
      closeButtonIcon={<ChevronRight />}
      closeButtonLabel="Close sources"
      width="20vw"
    >
      <ResourcePanel />
    </SlidingSidebar>
  )
}
```

**EditorSidebar** (`components/sidebars/editor-sidebar.tsx`):
```typescript
export function EditorSidebar() {
  const editorPanelOpen = useStore(state => state.editorPanelOpen)
  const toggleEditorPanel = useStore(state => state.toggleEditorPanel)
  const editorContent = useStore(state => state.editorContent)

  return (
    <SlidingSidebar
      isOpen={editorPanelOpen}
      onClose={toggleEditorPanel}
      closeButtonIcon={<ChevronRight />}
      closeButtonLabel="Close editor"
    >
      <MarkdownDemo />
    </SlidingSidebar>
  )
}
```

### 2.6.7 Dashboard Layout

**Location**: `app/dashboard/page.tsx`

The main dashboard page composition:

```typescript
export default function Page() {
  return (
    <div className="h-screen overflow-hidden">
      <SidebarProvider>
        <AppSidebar />        // Left navigation sidebar

        <ChatSidebar />       // Right sliding chat panel
        <SourcesSidebar />    // Right sliding sources panel
        <EditorSidebar />     // Right sliding editor panel

      </SidebarProvider>
    </div>
  )
}
```

### 2.6.8 CSS Animations

**Location**: `app/globals.css`

The application defines several animations for panel transitions:

```css
/* Slide in from right */
@keyframes slide-in-right {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.animate-slide-in-right {
  animation: slide-in-right 0.3s ease-out forwards;
}

/* Slide out to right */
@keyframes slide-out-right {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(100%);
    opacity: 0;
  }
}

.animate-slide-out-right {
  animation: slide-out-right 0.3s ease-out forwards;
}

/* Message animations */
@keyframes message-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-message-in {
  animation: message-in 0.3s ease-out forwards;
}
```

### 2.6.9 Layout State Management

Panel visibility is managed in the Zustand store:

```typescript
// Store state
sourcesPanelOpen: boolean  // Sources panel visibility
chatPanelOpen: boolean     // Chat panel visibility
editorPanelOpen: boolean   // Editor panel visibility

// Store actions
toggleSourcesPanel: () => void
toggleChatPanel: () => void
toggleEditorPanel: () => void
openPanel: (panelName, group?) => void  // Opens panel and closes others in group
```

**Panel Group Logic**:
```typescript
// When opening a panel, close others in the same group
const openPanel = (panelName, group = "sliding") => {
  // Close all panels in "sliding" group except the target
  if (panelName === "chatPanelOpen") {
    set({ editorPanelOpen: false, sourcesPanelOpen: false })
  }
  // Toggle the target panel
  set(state => ({ [panelName]: !state[panelName] }))
}
```

---

## 3. Component Interaction Flow

```
AppSidebar (application.tsx)
    |
    +---> Navigation buttons (Sources, Chat, Editor)
    |         +---> openPanel() action
    |         +---> Sets panel states in store
    |
    +---> Sessions list
              +---> ConversationItem components
              +---> createConversation, deleteConversation, renameConversation, togglePin

SlidingSidebar (reusable wrapper)
    |
    +---> ChatSidebar ---> ChatPanel
    |         +---> Messages display
    |         +---> Input bar with SelectedFilesPopover
    |
    +---> EditorSidebar ---> MarkdownDemo (or EditorPanel)
    |
    +---> SourcesSidebar ---> ResourcePanel
              +---> File upload with drag-and-drop
              +---> File selection
              +---> File list with search

ChatPanel <---> EditorPanel
    |
    +---> setEditorContent() syncs chat to editor
    |
    +---> SelectedFilesPopover ---> ResourcePanel
              +---> File selection synced to useSessionStore
```

---

## 4. Implementation Notes

### 4.1 SSR Considerations

1. **Hydration Mismatch Prevention**:
   - Use `useHydrated` hook to delay rendering until client-side
   - Format dates/times in client-only components
   - Use `suppressHydrationWarning` on root html element
   - Read theme from localStorage synchronously to prevent flash

2. **Theme Handling**:
   - Default to dark theme
   - Use CSS variables for theming
   - Toggle between light/dark with CSS class

### 4.2 Performance Optimizations

1. **Memoization**:
   - Use `useMemo` for expensive computations
   - Use `useCallback` for event handlers
   - Use `useHydrated` to prevent SSR issues

2. **State Updates**:
   - Batch related state updates
   - Use Zustand's selective subscriptions
   - Avoid unnecessary re-renders

3. **Rendering**:
   - Code splitting with Next.js dynamic imports
   - Lazy loading for panels (optional)

### 4.3 Accessibility

1. **Keyboard Navigation**:
   - Proper focus management
   - ARIA labels on interactive elements

2. **Screen Readers**:
   - Semantic HTML
   - ARIA attributes where needed

---

## 5. Dependencies Deep Dive

### 5.1 Package.json Dependencies

```json
{
  "dependencies": {
    "@ai-sdk/react": "^3.0.92",
    "@platejs/ai": "^52.1.0",
    "@platejs/markdown": "^52.1.0",
    "ai": "^6.0.90",
    "clsx": "^2.1.1",
    "date-fns": "^4.1.0",
    "lucide-react": "^0.564.0",
    "next": "16.1.6",
    "platejs": "^52.0.17",
    "react": "19.2.3",
    "react-dom": "19.2.3",
    "react-resizable-panels": "^4",
    "slate": "^0.123.0",
    "slate-react": "^0.123.0",
    "tailwind-merge": "^3.4.1",
    "zustand": "^5.0.11"
  }
}
```

### 5.2 Plate.js Editor Configuration

The editor uses a custom kit setup:

```typescript
// components/third-party/plate/editor/editor-kit.tsx
import { createSlatePlugin } from '@platejs/slate'
import { createBasicElementsPlugin } from '@platejs/basic-nodes'
import { createListPlugin } from '@platejs/list'
// ... more plugins

export const EditorKit = [
  createSlatePlugin(),
  createBasicElementsPlugin(),
  createListPlugin(),
  // ... more plugins
]
```

### 5.3 UI Component Patterns

Using Shadcn UI pattern with Radix primitives:

```typescript
// Button component variants
interface ButtonProps extends React.ComponentProps<"button"> {
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
  size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg"
  asChild?: boolean
}
```

---

## 6. Build and Run Instructions

### 6.1 Installation

```bash
# Install dependencies
bun install
```

### 6.2 Development

```bash
# Start development server
bun run dev
```

The app runs on `http://localhost:3000`

### 6.3 Build

```bash
# Build for production
bun run build

# Start production server
bun run start
```

---

## 7. Current Features Summary

### Implemented Features

| Feature | Status | Location |
|---------|--------|----------|
| Multi-panel sliding layout | ✅ Complete | dashboard/page.tsx |
| Chat interface with messages | ✅ Complete | panels/chat.tsx |
| Rich text editor (Plate.js) | ✅ Complete | panels/editor.tsx |
| File upload and management | ✅ Complete | panels/sources.tsx |
| Conversation management | ✅ Complete | store + sidebar |
| Theme switching (dark/light) | ✅ Complete | store |
| File attachments in chat | ✅ Complete | chat.tsx popover |
| Responsive sidebar | ✅ Complete | sidebar.tsx |
| Message animations | ✅ Complete | chat.tsx |
| Typing indicator | ✅ Complete | chat.tsx |
| Auto-resize textarea | ✅ Complete | chat.tsx |
| File drag-and-drop | ✅ Complete | sources.tsx |
| File search/filter | ✅ Complete | sources.tsx |
| Session-based file selection | ✅ Complete | useSessionStore |
| Conversation pin/rename/delete | ✅ Complete | application.tsx |
| Message timestamps | ✅ Complete | chat.tsx |

### Not Yet Implemented (from original spec)

| Feature | Status | Notes |
|---------|--------|-------|
| Real AI integration | ❌ Not implemented | Mock responses only |
| Web search integration | ❌ Not implemented | |
| Database persistence | ❌ Not implemented | localStorage only |
| Authentication | ❌ Not implemented | |
| API routes | ❌ Not implemented | |
| Export functionality | ❌ Not implemented | |
| Version history | ❌ Not implemented | |
| Real-time streaming | ❌ Not implemented | Mock delay only |
| Message editing/deletion | ❌ Not implemented | In store, not UI |
| Keyboard shortcuts | ❌ Not implemented | |

---

## 8. Extending the Application

### 8.1 Adding New Panels

1. Create panel component in `components/panels/`
2. Create sidebar wrapper in `components/sidebars/`
3. Add store state for panel visibility
4. Add panel to dashboard page

### 8.2 Adding AI Integration

1. Create API route in `app/api/chat/`
2. Integrate with OpenAI/Anthropic API
3. Replace `simulateAIResponse` with actual API call

**Example API route structure**:

```typescript
// app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { messages, files } = await req.json()

  // Call AI API with messages and file context
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [...messages],
      stream: true,
    }),
  })

  // Handle streaming response
  return new NextResponse(response.body, {
    headers: {
      'Content-Type': 'text/plain',
    },
  })
}
```

### 8.3 Adding Database

1. Set up Prisma with chosen database
2. Create schema for User, Conversation, Message, File
3. Add API routes for CRUD operations
4. Replace localStorage persistence with database

**Example Prisma Schema**:

```prisma
model User {
  id            String         @id @default(cuid())
  email         String         @unique
  conversations Conversation[]
  files         UploadedFile[]
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt
}

model Conversation {
  id        String    @id @default(cuid())
  title     String
  messages  Message[]
  pinned    Boolean  @default(false)
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Message {
  id             String       @id @default(cuid())
  role           String       // 'user' | 'assistant'
  content        String
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id])
  createdAt      DateTime     @default(now())
}

model UploadedFile {
  id          String   @id @default(cuid())
  name        String
  size        Int
  type        String
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  uploadedAt  DateTime @default(now())
}
```

---

## 9. Key Files Reference

| File | Purpose |
|------|---------|
| `lib/hooks/use-store.ts` | Global state management with Zustand |
| `components/panels/chat.tsx` | Chat interface with messages and input |
| `components/panels/editor.tsx` | Plate.js rich text editor |
| `components/panels/sources.tsx` | File management with drag-and-drop |
| `components/sidebars/application.tsx` | Main navigation sidebar |
| `components/sidebars/sliding-sidebar.tsx` | Reusable sliding panel wrapper |
| `app/dashboard/page.tsx` | Main layout with all panels |
| `app/globals.css` | CSS variables and design system |
| `lib/file-utils.tsx` | File processing utilities |
| `lib/utils.ts` | cn() utility for Tailwind |
| `layout/conversation-item.tsx` | Conversation list item component |
| `package.json` | All dependencies |
| `components/ui/sidebar.tsx` | Shadcn sidebar component |

---

## 10. Version Information

| Technology | Version |
|------------|---------|
| Next.js | 16.1.6 |
| React | 19.2.3 |
| Zustand | 5.0.11 |
| Tailwind CSS | 4 |
| Plate.js | 0.123.0 |
| Bun | Latest |
| TypeScript | 5.x |

---

## 11. Development Workflow

### 11.1 Running the Application

1. **Install dependencies**:
   ```bash
   bun install
   ```

2. **Start development server**:
   ```bash
   bun run dev
   ```

3. **Open browser**:
   Navigate to `http://localhost:3000`

### 11.2 Project Structure Conventions

- **Components**: Organized by feature (panels, sidebars) and type (ui)
- **State**: All global state in Zustand store (`lib/hooks/use-store.ts`)
- **Utilities**: Shared utilities in `lib/` folder
- **Types**: TypeScript interfaces co-located with their usage

### 11.3 Code Style

- Use TypeScript for type safety
- Use Tailwind CSS for styling with CSS variables
- Use Zustand for state management
- Use Shadcn UI patterns for components
- Follow React best practices (hooks, memoization)

---

This document provides a complete blueprint for understanding, reproducing, and extending the Chat Assistant application. All implementation details are based on the actual codebase structure and code patterns used.

The application is a functional prototype with:
- Multi-panel chat interface
- Rich text editing capabilities
- File upload and management
- Conversation management
- Theme switching

Future enhancements can include real AI integration, database persistence, authentication, and more advanced features as outlined in the original requirements.
