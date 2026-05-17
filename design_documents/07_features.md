# Features

This document lists all features of the application with their implementation status.

---

## 1. Implemented Features

### 1.1 Layout Features

| Feature | Status | Location |
|---------|--------|----------|
| Tabbed main-area layout (single panel mounted at a time) | ✅ Complete | dashboard/page.tsx (MainArea) |
| `activeView` store field + `setActiveView` action | ✅ Complete | lib/hooks/use-store.ts |
| Responsive sidebar | ✅ Complete | sidebar.tsx |
| Collapsible sidebar | ✅ Complete | sidebar.tsx |
| Workspaces overview main view | ✅ Complete | panels/workspaces.tsx |
| Workspaces sidebar tab (static label, no popover) | ✅ Complete | sidebars/application.tsx |
| Editor top-level sidebar tab | ✅ Complete | sidebars/application.tsx |
| Resources collapsible group containing "Files" sub-item | ✅ Complete | sidebars/application.tsx |
| Chats collapsible group with `+` new-chat action | ✅ Complete | sidebars/application.tsx |

### 1.2 Chat Features

| Feature | Status | Location |
|---------|--------|----------|
| Chat interface with messages | ✅ Complete | panels/chat.tsx |
| Message display with roles | ✅ Complete | panels/chat.tsx |
| User/assistant avatars | ✅ Complete | panels/chat.tsx |
| Message timestamps | ✅ Complete | panels/chat.tsx |
| Message animations | ✅ Complete | panels/chat.tsx |
| Typing indicator | ✅ Complete | panels/chat.tsx |
| Auto-resize textarea | ✅ Complete | panels/chat.tsx |
| Send on Enter | ✅ Complete | panels/chat.tsx |
| Shift+Enter for newline | ✅ Complete | panels/chat.tsx |
| Auto-scroll to new messages | ✅ Complete | panels/chat.tsx |

### 1.3 Editor Features

| Feature | Status | Location |
|---------|--------|----------|
| Rich text editor (Plate.js) | ✅ Complete | panels/editor.tsx |
| Markdown deserialization | ✅ Complete | panels/editor.tsx |
| Content sync from chat | ✅ Complete | panels/editor.tsx |

### 1.4 File Management Features

| Feature | Status | Location |
|---------|--------|----------|
| File upload | ✅ Complete | panels/sources.tsx |
| Drag-and-drop upload | ✅ Complete | panels/sources.tsx |
| File type validation | ✅ Complete | lib/file-utils.tsx |
| File size validation | ✅ Complete | lib/file-utils.tsx |
| File search/filter | ✅ Complete | panels/sources.tsx |
| File selection with checkboxes | ✅ Complete | panels/sources.tsx |
| File deletion | ✅ Complete | panels/sources.tsx |
| File hover cards | ✅ Complete | panels/sources.tsx |
| File icons | ✅ Complete | lib/file-utils.tsx |
| File attachments in chat | ✅ Complete | chat.tsx popover |
| Inline workspace context rail in chat | ✅ Complete | panels/chat-context-rail.tsx |

### 1.5 Conversation Features

| Feature | Status | Location |
|---------|--------|----------|
| Conversation management | ✅ Complete | store + sidebar |
| Create new conversation | ✅ Complete | use-store.ts |
| Delete conversation | ✅ Complete | use-store.ts |
| Rename conversation | ✅ Complete | use-store.ts |
| Pin conversation | ✅ Complete | use-store.ts |
| Active conversation selection | ✅ Complete | use-store.ts |
| Demo conversation | ✅ Complete | use-store.ts |
| Workspace-scoped Chats dropdown in sidebar | ✅ Complete | sidebars/application.tsx (`useWorkspaceConversations`) |

### 1.7 Workspace Features

| Feature | Status | Location |
|---------|--------|----------|
| Workspaces overview grid | ✅ Complete | panels/workspaces.tsx |
| Create / rename / delete workspace from main view | ✅ Complete | panels/workspaces.tsx |
| Quick-switch popover (chevron in sidebar) | ✅ Complete | sidebars/application.tsx |
| Workspace-scoped conversations and resources | ✅ Complete | use-store.ts |

### 1.6 Theme Features

| Feature | Status | Location |
|---------|--------|----------|
| Theme switching (dark/light) | ✅ Complete | use-store.ts |
| System theme support | ✅ Complete | use-store.ts |
| Theme persistence | ✅ Complete | use-store.ts |
| No flash on load | ✅ Complete | use-store.ts |

---

## 2. Not Yet Implemented

### 2.1 AI Features

| Feature | Status | Notes |
|---------|--------|-------|
| Real AI integration | ❌ Not implemented | Mock responses only |
| Web search integration | ❌ Not implemented | |
| Real-time streaming | ❌ Not implemented | Mock delay only |
| Context window management | ❌ Not implemented | |
| Function calling | ❌ Not implemented | |

### 2.2 Database Features

| Feature | Status | Notes |
|---------|--------|-------|
| Database persistence | ❌ Not implemented | localStorage only |
| User accounts | ❌ Not implemented | |
| Cloud sync | ❌ Not implemented | |

### 2.3 Backend Features

| Feature | Status | Notes |
|---------|--------|-------|
| API routes | ❌ Not implemented | |
| Authentication | ❌ Not implemented | |
| File storage | ❌ Not implemented | |

### 2.4 UI Features

| Feature | Status | Notes |
|---------|--------|-------|
| Message editing | ❌ Not implemented | Store action exists, no UI |
| Message deletion | ❌ Not implemented | Store action exists, no UI |
| Keyboard shortcuts | ❌ Not implemented | Sidebar toggle only |

### 2.5 Export Features

| Feature | Status | Notes |
|---------|--------|-------|
| Export to PDF | ❌ Not implemented | |
| Export to DOCX | ❌ Not implemented | |
| Export to Markdown | ❌ Not implemented | |

### 2.6 Advanced Features

| Feature | Status | Notes |
|---------|--------|-------|
| Version history | ❌ Not implemented | |
| Collaborative editing | ❌ Not implemented | |
| Citation management | ❌ Not implemented | |
| Report generation | ❌ Not implemented | |

---

## 3. Feature Priority

### 3.1 High Priority

1. Real AI integration
2. API routes
3. Database persistence

### 3.2 Medium Priority

1. Message editing/deletion UI
2. Export functionality
3. Keyboard shortcuts

### 3.3 Low Priority

1. Collaborative editing
2. Version history
3. Advanced citation management

---

## 4. Related Documents

- [08_extension_guide.md](08_extension_guide.md) - How to extend the application
