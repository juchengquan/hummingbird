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
| Real AI integration via Vercel AI Gateway (streaming) | ✅ Complete | app/api/chat/route.ts |
| Default model `deepseek/deepseek-v4-flash` (selectable) | ✅ Complete | lib/models.ts |
| Reasoning / "thinking" token surfacing | ✅ Complete | panels/chat-message.tsx (`ReasoningBlock`) |
| Streaming markdown rendering in assistant messages | ✅ Complete | components/markdown-preview.tsx |
| Suggested follow-up question chips | ✅ Complete | app/api/chat/route.ts (suggestions SSE frame) |
| Per-message attached-file snapshot (image chips, etc.) | ✅ Complete | `Message.attachedFileIds` |
| Bubble-less assistant messages; user has a subtle tinted bubble | ✅ Complete | panels/chat-message.tsx (`--user-bubble` token) |
| Message column width `max-w-[90%]` | ✅ Complete | panels/chat-message.tsx |
| Message timestamps | ✅ Complete | panels/chat-message.tsx (`MessageTime`) |
| Message animations | ✅ Complete | panels/chat-message.tsx (`animate-message-in`) |
| Typing indicator (no avatar) | ✅ Complete | panels/chat.tsx |
| Auto-resize textarea | ✅ Complete | panels/chat.tsx |
| Send on Enter / Shift+Enter for newline | ✅ Complete | panels/chat.tsx |
| Auto-scroll to new messages | ✅ Complete | panels/chat.tsx (direct Viewport scroll) |
| Mock AI fallback (when `AI_GATEWAY_API_KEY` missing) — includes reasoning | ✅ Complete | panels/chat.tsx (`mockAIResponse`) |

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
| File attachments in chat (per-conversation, persisted) | ✅ Complete | Conversation.selectedFileIds |
| Inline workspace resources side panel in chat | ✅ Complete | panels/chat-resources-panel.tsx |

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
| Theme switching (Light / Dark / System) | ✅ Complete | components/theme-toggle.tsx |
| System theme support with media-query listener | ✅ Complete | components/theme-applier.tsx |
| Theme persistence | ✅ Complete | use-store.ts (persist partialize) |
| No flash on load (pre-hydration script in `<head>`) | ✅ Complete | app/layout.tsx |

### 1.7 Auth & Sync

| Feature | Status | Location |
|---------|--------|----------|
| Email + password sign-in (Supabase Auth) | ✅ Complete | components/auth/auth-dialog.tsx, lib/hooks/use-auth.ts |
| Anonymous-first; sign-in unlocks cross-device | ✅ Complete | lib/sync/sync-queue.ts (no-op when no session) |
| Background sync queue (FIFO, retries, offline-pause) | ✅ Complete | lib/sync/sync-queue.ts |
| Per-entity diff handlers | ✅ Complete | lib/sync/handlers.ts |
| Snapshot-diff observer hook | ✅ Complete | lib/hooks/use-sync.ts |
| First-sign-in reconciliation dialog | ✅ Complete | components/auth/reconcile-dialog.tsx |
| Refresh / reconnect pulls cloud → local (silent) | ✅ Complete | lib/hooks/use-reconcile.ts |
| Reconciled-users marker (skip dialog after first time) | ✅ Complete | localStorage `hummingbird-reconciled-users` |
| File uploads → Supabase Storage when signed in | ✅ Complete | hooks/use-upload-file.ts |
| File uploads → UploadThing when signed out | ✅ Complete | hooks/use-upload-file.ts |
| Migration `0004` — runtime metadata columns | ✅ Schema committed | supabase/migrations/0004_runtime_metadata.sql |

### 1.8 Server-side

| Feature | Status | Location |
|---------|--------|----------|
| `/api/chat` SSE streaming | ✅ Complete | app/api/chat/route.ts |
| `/api/ai/copilot` editor inline AI | ✅ Complete | app/api/ai/copilot/route.ts |
| `/api/ai/command` editor multi-action AI | ✅ Complete | app/api/ai/command/route.ts |
| `/api/extract` text extraction (PDF/DOCX/MD/CSV/JSON/TXT) | ✅ Complete | app/api/extract/route.ts |
| `/api/summarize` background file summarisation | ✅ Complete | app/api/summarize/route.ts |
| `/api/uploadthing` legacy upload endpoint | ✅ Complete | app/api/uploadthing/route.ts |
| `/auth/callback` Supabase confirmation/OAuth handler | ✅ Complete | app/auth/callback/route.ts |
| Zod request validation | ✅ Complete | lib/api-schemas.ts |
| `serverExternalPackages` for pdf-parse / pdfjs-dist / mammoth | ✅ Complete | next.config.ts |

---

## 2. Not Yet Implemented

### 2.1 Sync follow-ups

| Feature | Status | Notes |
|---------|--------|-------|
| `image_data_url` → Supabase Storage cutover | ❌ Phase 2 | Today base64 lives in the `files` row; Phase 2 moves binary blobs to Storage. |
| Realtime cross-device sync | ❌ Phase 3 | `supabase.channel().on('postgres_changes', …)` |
| Share links | ❌ Phase 4 | `shares` table + `/share/conversation/[token]`. |
| Persist `reasoning_duration_ms` | ❌ | Today the "Thought for X.Xs" timing is component-local and lost on refresh; needs a small 0005 + Message field. |

### 2.2 Product

| Feature | Status | Notes |
|---------|--------|-------|
| Mobile layout (`<lg` breakpoint) | ❌ | `chat-resources-panel.tsx` is `hidden lg:flex`; panel disappears on phones. |
| Cross-workspace / ⌘F message search | ❌ | Today search is title + first ~100 messages within active workspace only. |
| Slash commands / prompt templates | ❌ | Command palette infra ready to extend. |
| Inline citations to source files | ❌ | Prompt the model to cite by `[filename]`; parser turns brackets into links. Halfway to RAG. |
| Voice input / TTS playback | ❌ | Web Speech API; no infra. |
| Accessibility pass | ❌ | <20 aria-labels app-wide. |
| Tests | ❌ | Zero coverage. Start with store reducers + chat-panel smoke test. |

---

## 4. Related Documents

- [08_extension_guide.md](08_extension_guide.md) - How to extend the application
