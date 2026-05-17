# UI Layout System

This document details the tabbed main-area layout: the `AppSidebar` (left) drives a single `SidebarInset` (right) that swaps between four panels based on `activeView`. Sliding right-side sidebars are no longer mounted.

---

## 1. Layout Architecture Overview

```
┌─────────────┬───────────────────────────────────────────────┐
│ AppSidebar  │            SidebarInset (Main Area)           │
│  (Left)     │                                               │
│             │   ┌─────────────────────────────────────────┐ │
│ Workspaces  │   │   ONE of:                               │ │
│ Editor      │   │     WorkspacesPanel  (activeView ==     │ │
│             │   │                       'workspaces')     │ │
│ ▾ Resources │   │     ChatPanel        ('chat')           │ │
│   • Files   │   │     ResourcePanel    ('resources')      │ │
│             │   │     EditorPanel      ('editor')         │ │
│ ▾ Chats  +  │   │                                         │ │
│   - Chat 1  │   │   ChatPanel composition:                │ │
│   - Chat 2  │   │     • ChatContextRail (workspace files) │ │
│             │   │     • Message scroll area               │ │
│             │   │     • Input bar (absolute bottom)       │ │
│             │   └─────────────────────────────────────────┘ │
└─────────────┴───────────────────────────────────────────────┘
```

**Switch-over behavior:** clicking any tab/sub-item in the sidebar calls `setActiveView(...)` and `MainArea` swaps the rendered panel. Only one panel is mounted at a time — there are no overlays.

**Sidebar → main-area mapping:**
| Sidebar control | Action | View |
|---|---|---|
| **Workspaces** (top-level button) | `setActiveView('workspaces')` | `WorkspacesPanel` |
| **Editor** (top-level button) | `setActiveView('editor')` | `EditorPanel` |
| **Resources ▸ Files** (sub-item) | `setActiveView('resources')` | `ResourcePanel` |
| **Chats** header `+` | `createConversation()` + `setActiveView('chat')` | `ChatPanel` |
| **Chats ▸ <conversation>** | `setActiveConversation(id)` + `setActiveView('chat')` | `ChatPanel` |

The Resources and Chats groups are `CollapsibleTrigger` headers — clicking them only expands/collapses; the view switch happens on their child items.

The legacy `ChatSidebar`, `ResourcesSidebar`, and `EditorSidebar` wrappers are not mounted by `app/dashboard/page.tsx`. They still exist on disk but are dead code from the dashboard's perspective.

---

## 2. SidebarProvider

### 2.1 Location

`components/ui/sidebar.tsx`

### 2.2 Purpose

Provides context for all sidebar components and manages the collapsed/expanded state.

### 2.3 Usage

```typescript
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar"

<SidebarProvider defaultOpen={true}>
  <AppSidebar />
  <ChatSidebar />
  <SourcesSidebar />
  <EditorSidebar />
</SidebarProvider>
```

### 2.4 Context Values

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

### 2.5 Configuration Constants

```typescript
const SIDEBAR_COOKIE_NAME = "sidebar_state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7  // 7 days
const SIDEBAR_WIDTH = "16rem"        // 256px
const SIDEBAR_WIDTH_MOBILE = "18rem"  // 288px
const SIDEBAR_WIDTH_ICON = "3rem"     // 48px
const SIDEBAR_KEYBOARD_SHORTCUT = "b" // Cmd/Ctrl + B to toggle
```

### 2.6 Keyboard Shortcut

The sidebar can be toggled using **Cmd/Ctrl + B**:

```typescript
React.useEffect(() => {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (
      event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault()
      toggleSidebar()
    }
  }

  window.addEventListener("keydown", handleKeyDown)
  return () => window.removeEventListener("keydown", handleKeyDown)
}, [toggleSidebar])
```

### 2.7 Cookie Persistence

Sidebar state is persisted in a cookie for 7 days:

```typescript
document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
```

---

## 4. Resizable Panels

### 4.1 Location

`components/ui/resizable.tsx`

### 4.2 Library

Uses `react-resizable-panels` for draggable panel resizing.

### 4.3 Components

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

### 4.4 API

| Component | Props | Description |
|-----------|-------|-------------|
| `ResizablePanelGroup` | `orientation`, `className` | Container for panels |
| `ResizablePanel` | `defaultSize`, `minSize`, `maxSize`, `children` | Individual panel |
| `ResizableHandle` | `withHandle`, `className` | Drag handle between panels |

---

## 5. Sidebar Variants

### 5.1 Variants

| Variant | Description |
|---------|-------------|
| `sidebar` | Default sidebar with border |
| `floating` | Floating sidebar with rounded corners and shadow |
| `inset` | Inset sidebar for use inside other containers |

### 5.2 Collapsible Modes

| Mode | Behavior |
|------|----------|
| `offcanvas` | Slides out of view completely |
| `icon` | Collapses to icon-only mode |
| `none` | Always shows full width |

---

## 6. Legacy Panel Sidebar Wrappers

`ChatSidebar`, `ResourcesSidebar`, and `EditorSidebar` still exist on disk (`components/sidebars/*.tsx`) but **none are mounted by the dashboard anymore**. Their underlying `*PanelOpen` booleans remain in the store for migration safety only. All three panel components (`ChatPanel`, `ResourcePanel`, `EditorPanel`) are now rendered directly inside `SidebarInset` by `MainArea`. The wrapper files can be deleted once nothing else imports them.

---

## 7. Dashboard Layout

### 7.1 Location

`app/dashboard/page.tsx`

### 7.2 Composition

```typescript
function MainArea() {
  const activeView = useStore((s) => s.activeView)
  const editorContent = useStore((s) => s.editorContent)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  if (!mounted) return null   // avoid hydration mismatch with persisted store

  return (
    <SidebarInset className="h-full overflow-hidden">
      {activeView === "workspaces" && <WorkspacesPanel />}
      {activeView === "chat" && <ChatPanel />}
      {activeView === "resources" && <ResourcePanel />}
      {activeView === "editor" && <EditorPanel initialContent={editorContent} />}
    </SidebarInset>
  )
}

export default function Page() {
  return (
    <div className="h-screen overflow-hidden">
      <SidebarProvider>
        <AppSidebar />
        <MainArea />
      </SidebarProvider>
    </div>
  )
}
```

Selecting a chat in the sidebar's Chats collapsible calls `setActiveConversation(id)` and `setActiveView('chat')`, so `ChatPanel` reads the new conversation and `MainArea` swaps to it.

### 7.3 Workspace Context

When a workspace is selected:
- **WorkspacesPanel** highlights it with the "Active" badge
- **ResourcesSidebar** shows files linked to that workspace
- The AppSidebar Chats collapsible filters to the active workspace's conversations
- The AppSidebar "Chats" collapsible filters to show only the active workspace's conversations (via `useWorkspaceConversations`)

---

## 8. CSS Animations

### 8.1 Location

`app/globals.css`

### 8.2 Slide Animations

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
```

### 8.3 Message Animations

```css
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

---

## 9. Layout State Management

### 9.1 Active View

The dashboard reads a single store field:

```typescript
type MainView = 'workspaces' | 'chat' | 'resources' | 'editor'

// Store state
activeView: MainView           // default: 'workspaces'

// Store action
setActiveView: (view: MainView) => void
```

All sidebar tabs call `setActiveView(...)`, and `MainArea` switches the rendered panel. Because only one panel is mounted at a time, the previous "sliding-panel group" mutual-exclusion logic is no longer needed. The legacy `*PanelOpen` booleans, their toggle actions, and `openPanel` have been removed from the store; a Zustand persist `migrate` (`version: 2`) strips them from any pre-existing localStorage payload on next load.

---

## 10. Mobile Responsiveness

### 10.1 Mobile Detection

```typescript
const isMobile = useIsMobile()  // Custom hook
```

### 10.2 Mobile Behavior

On mobile devices:
- Sidebar becomes an off-canvas drawer
- Triggered by hamburger menu icon
- Closes when clicking outside or selecting an item

---

## 11. Related Documents

- [01_project_overview.md](01_project_overview.md) - Project foundation
- [02_state_management.md](02_state_management.md) - State management
- [03_ui_components.md](03_ui_components.md) - UI components
