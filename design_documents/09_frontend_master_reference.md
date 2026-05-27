# Frontend Master Reference

> **Last synced:** 2026-05-24 (post-right-rail-polish: Anthropic color scheme, search bars, rail reorder, MCP/links simplification).
> implementation — layout, components, state, data flow, and APIs. Every
> claim includes a `[file:line]` link to the source code.
>
> Companion to the existing design documents (01–08) which capture more
> granular detail on specific subsystems. This file is the map; those
> files are the zoomed-in views.

---

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  app/layout.tsx [27]                                                 │
│  ┌─ ThemeApplier (syncs .dark on <html>) [components/theme-applier]  │
│  └─ TooltipProvider {children}                                       │
│                                                                      │
│  app/dashboard/page.tsx [86]                                         │
│  ┌─ SidebarProvider                                                  │
│  │  ├─ SyncMount [42] (useSync orchestrator, hidden)                 │
│  │  ├─ ReconcileMount (useReconcile + ReconcileDialog, hidden)       │
│  │  ├─ AppSidebar [sidebars/application:40]         ← left rail     │
│  │  ├─ MainArea [41]                                ← center panel   │
│  │  │   └─ switches on activeView:                                    │
│  │  │       "workspaces" → WorkspacesPanel [panels/workspaces:41]    │
│  │  │       "chat"       → ChatPanel [panels/chat:66]                │
│  │  │       "resources"  → ResourcePanel [panels/sources:39]         │
│  │  │       "editor"     → EditorPanel [panels/editor:63]            │
│  │  ├─ CommandPalette [command-palette:63]         ← ⌘K overlay     │
│  │  ├─ PdfViewerHost, UrlPreviewHost, ...          ← right-panel    │
│  │  │     ImageViewerHost, DocxViewerHost,                           │
│  │  │     TextViewerHost, CsvViewerHost                               │
│  │  └─ Toaster                                                       │
│  └───────────────────────────────────────────────────────────────────│
└──────────────────────────────────────────────────────────────────────┘
```

**Key principle:** Single-panel-at-a-time in the main area. The
`activeView` field in the Zustand store drives which component renders
in `SidebarInset`. No sliding panel group, no overlays. The old boolean
panel flags were removed in persist version 2.

**Right rail:** Only in the Chat view. The `ResourcesSidebar`
[sidebars/resources:71] is a collapsible right panel (expanded `w-80` or
collapsed `w-12` icon strip) that shows workspace resources, notes, and
artifacts via `ChatResourcesPanel` [panels/chat-resources-panel:43].

---

## 2. View Routing

```
                    ┌─────────────────┐
                    │   AppSidebar    │
                    │ [application:40] │
                    └────────┬────────┘
                             │ setActiveView()
        ┌────────────────────┼──────────────────────┐
        v                    v                      v
┌───────────────┐   ┌───────────────┐   ┌───────────────────┐
│ WorkspacesPanel│   │   ChatPanel   │   │  ResourcePanel    │
│ [workspaces:41]│   │   [chat:66]   │   │   [sources:39]    │
└───────────────┘   └───────┬───────┘   └───────────────────┘
                            │
                     ┌──────┴──────┐
                     │ ChatHeader  │ [chat-header:77]
                     │ ContextMeter│ [context-meter:44]
                     │ CompressBtn │
                     └──────┬──────┘
                            │
              ┌─────────────┼─────────────┐
              v             v             v
         ChatMessage    SourcesStrip   ReasoningBlock
         [chat-msg:71]  [sources-strip] [reasoning-block]
```

**View switch table:**

| Sidebar action | Store calls | Result |
|---|---|---|
| Click **Workspaces** | `setActiveView('workspaces')` | WorkspacesPanel |
| Click **Editor** | `setActiveView('editor')` | EditorPanel |
| Click **Resources ▸ Files** | `setActiveView('resources')` | ResourcePanel |
| Click **Chat** item | `setActiveConversation(id)` + `setActiveView('chat')` | ChatPanel |
| Click **+** on Chats | `createConversation()` + `setActiveView('chat')` | ChatPanel (new, empty) |
| ⌘K → "Go to Chat" | `setActiveView('chat')` | ChatPanel |

---

## 3. The Chat Panel — Deep Dive

### 3.1 Layout

`components/panels/chat.tsx:66` — the largest component (~2100 lines).

```
┌───────────────────────────────┬──────────────┐
│  ChatHeader [chat-header:77] │ Resources    │
│  ─ ModelPicker ─ ContextMeter│ Sidebar      │
│  ─ Share/Branches/Export     │ [resources:71│
│                               │              │
│  ActiveSkillsChips [skills/   │ expanded:    │
│  active-chips:31]             │  w-80, tabs  │
│                               │  Files Notes │
│  ┌─ Message list (scroll) ──┐│  Artifacts   │
│  │ ChatMessage [chat-msg:71]││              │
│  │ SourcesStrip              ││ collapsed:   │
│  │ ReasoningBlock            ││  w-12 rail   │
│  │ GeneratedImagesGallery    ││              │
│  └───────────────────────────┘│              │
│                               │              │
│  ┌─ Input area ─────────────┐│              │
│  │ SlashAutocomplete [slash- ││              │
│  │ autocomplete:37]         ││              │
│  │ [textarea + ContextPicker ││              │
│  │  + send button]           ││              │
│  └───────────────────────────┘│              │
└───────────────────────────────┴──────────────┘
```

### 3.2 Message Rendering

`components/panels/chat-message.tsx:71` (`ChatMessageImpl`, memo-wrapped
at `:624`). Asymmetric styling:

| Role | Alignment | Background | Content renderer |
|---|---|---|---|
| **User** | Right | Tinted bubble (`--user-bubble`) | Plain text (`whitespace-pre-wrap`) |
| **Assistant** | Left | No background, no padding | `<MarkdownPreview>` (GFM, tables, code, citations) |

**Additional message sub-components:**
- `ReasoningBlock` — if `message.reasoning` is non-empty, renders a
  collapsible "Thinking…" → "Reasoning" panel with duration
  (`components/panels/reasoning-block.tsx`)
- `SourcesStrip` — web search result cards with `[N]` citation badges,
  rendered below assistant messages (`components/panels/sources-strip.tsx`)
- `GeneratedImagesGallery` — grid of AI-generated images with Remix
  actions (`components/skills/generated-images-gallery.tsx`)
- `ErrorBubble` — destructive error display with code + Retry
  (`components/panels/error-bubble.tsx`)
- `MessageAttachments` — file chips for attached files on user messages
  (`components/panels/message-attachments.tsx`)
- `ToolCallStrip` — live tool-call progress pills during streaming
  (`components/skills/tool-call-strip.tsx`)
- Artifact previews, Save Artifact dialog, Fork/Suggestion actions

### 3.3 Chat Input

The chat input at the bottom of ChatPanel processes:

1. **`/` slash commands** — parsed by `lib/shared/slash-resolver.ts`.
   Two categories:
   - **Skill triggers** (e.g. `/search`, `/image`): token stays in the
     input; the corresponding skill is forced-on for this turn.
     Autocomplete via `SlashAutocomplete` [slash-autocomplete:37].
   - **Action commands** (e.g. `/new`, `/clear`, `/rename`, `/model`,
     `/help`): execute immediately without sending. Handled by
     `lib/client/hooks/use-slash-commands.ts`.

2. **`@<slug>` mention triggers** — parsed by
   `lib/shared/prompts/mention-parser.ts`. Expands a prompt template
   (with variable-fill modal) into the input.

3. **Smart paste** — detected via `lib/shared/smart-paste/detect.ts`.
   Recognizes URLs, images, and code blocks in pasted content.

4. **Context Picker** — the `ContextPicker` [context-picker:64] is a
   categorized popover next to the input listing workspace files,
   conversation files, URL bookmarks, and MCP resources that can be
   attached to this turn.

5. **Active skills chips** — `ActiveSkillsChips` [active-chips:31]
   renders a row of enabled skill badges above the input. Each chip
   shows the skill name + a × mute button for the next send.

### 3.4 Chat Send Flow

```
handleSendMessage() [chat.tsx:1154]
  │
  ├─ 1. Build attachments: workspace files + conversation files
  │     + URL bookmarks + MCP resources
  │
  ├─ 2. Resolve skills cascade:
  │     workspace.skillPrefs → conversation.skillPrefs
  │     + forced by /slash → − muted for this turn
  │
  ├─ 3. addMessage({ role: "user", content, attachedFileIds })
  │
  ├─ 4. callChatAPI(history, { forcedSkillIds, referenceImage })
  │     [chat.tsx:476]
  │     │
  │     ├─ Build MCP server list (local-mode from body,
  │     │   cloud-mode loaded server-side)
  │     │
  │     ├─ apiClient.chat.stream(payload, { signal })
  │     │   [api-client.ts:396]
  │     │   POST /api/chat → SSE stream
  │     │
  │     └─ Parse SSE frames [chat.tsx:827–]:
  │         "text"           → appendToMessage [chat.tsx:858]
  │         "reasoning"      → appendToMessageReasoning
  │         "tool_call"      → setLiveToolCalls (ephemeral)
  │         "tool_result"    → update liveToolCalls with results
  │         "tool_image"     → appendMessageGeneratedImages
  │         "suggestions"    → setMessageSuggestions
  │         "error"          → surfaceError
  │         "done"           → autoArchiveCodeBlocks,
  │                            persist reasoning duration
  │
  └─ 5. Cleanup: clear muted skills, pendingReferenceImage,
        paste detection
```

### 3.5 Chat Header

`components/panels/chat-header.tsx:77`:
- Breadcrumb: workspace name → conversation title
- Model picker (Select dropdown with provider grouping)
- Context meter (`ContextMeter` [context-meter:44]) — "12k / 200k" chip
  with color zones (muted → amber → red)
- Compress button (calls `/api/summarize` compress mode)
- Inline rename (Edit2 icon → Input → Check/X)
- Share button, Branches dialog, Export/Copy/Archive actions

---

## 4. The Editor Panel

`components/panels/editor.tsx:63` (299 lines) — Plate.js rich-text
editor rendered when `activeView === 'editor'`.

```
EditorPanel
  ├─ ResourcesSidebar (same right rail as Chat)
  ├─ Plate editor instance
  │   └─ usePlateEditor({ plugins: EditorKit })
  │       [components/editor/editor-kit.ts]
  │       (composes ~30 plugin kits)
  │
  ├─ Title: inline rename
  ├─ Toolbar: fixed toolbar with formatting buttons
  │   [components/ui/fixed-toolbar.tsx]
  │
  └─ Document flow:
      loadMarkdown(content) → Plate nodes
      onChange → debounced (500ms) → serializeMd → setDocumentContent
```

**Editor plugins** (`components/editor/plugins/`, 57 files):
Each plugin has a "base kit" (static rendering) + "full kit"
(interactive). Key plugins: `ai`, `align`, `autoformat`, `basic-blocks`,
`basic-marks`, `callout`, `code-block`, `column`, `comment`, `copilot`,
`dnd`, `emoji`, `link`, `list`, `markdown`, `math`, `media`, `mention`,
`slash`, `suggestion`, `table`, `toc`, `toggle`.

**AI integration:**
- `POST /api/ai/command` — Plate.js AI command (325 lines,
  `app/api/ai/command/route.ts`)
- `POST /api/ai/copilot` — Plate.js copilot (55 lines,
  `app/api/ai/copilot/route.ts`)
- Diff mode: AI suggestions rendered with accept/reject per-hunk
  (`components/editor/ai-review-pill.tsx`,
  `components/editor/ai-review-keymap.tsx`)

---

## 5. Side Bars & Panels

### 5.1 AppSidebar (left rail)

`components/sidebars/application.tsx:40` (518 lines). Drives the
tabbed main area.

```
AppSidebar
├─ SidebarTrigger (collapse toggle)
├─ Workspaces (top-level button → setActiveView('workspaces'))
├─ Editor (top-level button → setActiveView('editor'))
├─ Resources (collapsible)
│   └─ Files (sub-item → setActiveView('resources'))
├─ Chats (collapsible, filtered to active workspace)
│   └─ ConversationItem[] (click → setActiveConversation + chat view)
├─ Prompts (collapsible)
│   └─ PromptItem[] (click → insert into chat input)
└─ SidebarFooter
    └─ AccountMenu (sign in/out, cloud sync, color scheme, theme, help, cache)
```

### 5.2 ResourcesSidebar (right rail, chat+editor only)

`components/sidebars/resources.tsx:71` (292 lines).
Two modes, persistent in the Zustand store:

| State | Width | Content |
|---|---|---|
| Expanded | `w-80` | `ChatResourcesPanel` with tab strip + active tab body |
| Collapsed | `w-12` | Vertical icon rail: Files, Links, Notes, Artifacts, Pins, MCP, Skills |

`ChatResourcesPanel` [chat-resources-panel:43] (259 lines) switches
between these tab bodies:

| Tab | Component | Purpose |
|---|---|---|
| Files | `FilesTabBody` | File list with attach checkboxes, upload, always-visible search |
| Links | `UrlBookmarksTab` | Saved web page bookmarks with search |
| Notes | `NotesTab` | Free-form notes + message bookmarks |
| Artifacts | `ArtifactsTab` | Saved code blocks, preview, delete |
| Pins | `PinsTab` | Selection-driven explain pins |
| MCP | `McpTab` | Workspace-level MCP resource list |
| Skills | `SkillsTab` [skills-tab:70] | Per-skill toggles + config + search |

### 5.3 Workspaces Panel

`components/panels/workspaces.tsx:41` (401 lines).
Card grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`).
- Each card: name, Active badge, chat count, file count, dates
- Inline rename, delete with AlertDialog confirmation
- Drag-to-reorder (dnd-kit)
- "New Workspace" card + header button

### 5.4 Resource Panel (Files)

`components/panels/sources.tsx:39` (353 lines).
Standalone file management. Drop zone, search, session-based selection
checkboxes, delete confirm, hover cards.

---

## 6. Viewers (right-panel slot)

The `right-panel-slot.ts` module (85 lines) coordinates six viewer
components, ensuring only one is open at a time:

| Viewer | Store | Purpose |
|---|---|---|
| `PdfViewerHost` | `usePdfViewer` | PDF.js-based viewer with page nav + zoom |
| `UrlPreviewHost` | `useUrlPreview` | Rendered web page bookmark content |
| `LiveArtifactHost` | `useLiveArtifact` | Sandboxed iframe for TSX/HTML/SVG/Mermaid |
| `ImageViewerHost` | `useImageViewer` | Full-screen image viewer |
| `DocxViewerHost` | `useDocxViewer` | DOCX rendered view |
| `CsvViewerHost` | `useCsvViewer` | CSV table viewer |
| `TextViewerHost` | `useTextViewer` | Plain text viewer |

---

## 7. Overlays

| Component | Trigger | Purpose |
|---|---|---|
| `CommandPalette` [command-palette:63] | ⌘K / Ctrl+K | Navigate views, create items, explain/quote selection |
| `ShareDialog` | Share button in chat header | Mint public share links |
| `BranchesDialog` | Branches button in chat header | Visual conversation fork tree |
| `ConversationSummaryDialog` | Chat header kebab | AI-powered summarization |
| `PromptDialog` | Prompt item add/edit | Create/edit prompt templates |
| `PromptVariableFill` | `@mention` expansion | Fill `{{variables}}` before insert |
| `SaveArtifactDialog` | Message code block | Multi-block picker for saving artifacts |
| `SlashHelpDialog` | `/help` command | List all slash commands |

---

## 8. State Management

### 8.1 Main Store

`lib/client/hooks/use-store.ts:813` — Zustand + `persist` middleware.
Storage key: `hummingbird-storage` (localStorage), version 6.

**Key slices:**

| Slice | Default | Notable fields |
|---|---|---|
| **theme** | `'dark'` | system / dark / light. `colorScheme` field (`'default' | 'anthropic'`) toggles warm orange vs neutral gray palette. |
| **activeView** | `'workspaces'` | drives MainArea routing |
| **sidebar** | `resourcesSidebarOpen: true`, `resourcesSidebarTab: 'files'` | Right rail collapse + tab state |
| **workspaces** | `[{ id: 'default' }]` | systemPrompt, defaultModel, skillPrefs |
| **conversations** | `[{ id: 'demo-1' }]` | messages[], selectedFileIds[], skillPrefs, pin |
| **messages** | (on conversations) | role, content, reasoning, error, toolCalls, generatedImages, compressed, kind |
| **files** | `[]` | extractionStatus, fullText, storagePath |
| **resources** | `[]` | fileId → workspaceId join |
| **notes** | `[]` | free-form text + message bookmarks |
| **artifacts** | `[]` | saved code blocks + outputs |
| **prompts** | `[]` | user-scoped templates with soft-delete |
| **mcpServers** | `[]` | MCP server configs |
| **chatModel** | (from models.ts) | Per-session model selection |
| **typingConversationIds** | `[]` | Tracks active streams (persisted exclusion) |
| **localOnlyMode** | `false` | Blocks sync even when signed in |

**Partialize** (excluded from persistence): `pendingChatInput`,
`pinnedExplanations`, `pendingSelectionAction`, `typingConversationIds`,
`streamingContent`, `sessionModelOverridden`, `pendingReferenceImage`.

### 8.2 Session Store

`lib/client/hooks/use-store.ts:2906` — separate Zustand store with
sessionStorage persistence (`hummingbird-session`).
- `selectedFileIds: string[]` — bulk selection checkboxes in the
  standalone ResourcePanel (not chat attachments)

### 8.3 Viewer Mini-Stores

Each viewer has its own Zustand store (not persisted):
- `usePdfViewer` — `components/pdf-viewer/types.ts`
- `useUrlPreview` — `components/url-viewer/types.ts`
- `useLiveArtifact` — `components/live-artifact/store.ts`
- `useImageViewer` — `components/image-viewer/types.ts`
- `useDocxViewer`, `useTextViewer`, `useCsvViewer`

### 8.4 Selectors (20+)

All in `use-store.ts` bottom section. Key ones:
`useActiveWorkspace`, `useActiveConversation`,
`useWorkspaceConversations`, `useWorkspaceResources`,
`useConversationSelectedFileIds`, `useWorkspaceDocuments`,
`useActiveDocument`, `useConversationArtifacts`, `useWorkspaceNotes`,
`useWorkspaceMcpServers`, `useIsConversationTyping`.

---

## 9. Data Flow

### 9.1 Chat (browser → server → browser)

```
User input → handleSendMessage [chat:1154]
  → callChatAPI [chat:476]
    → apiClient.chat.stream(payload) [api-client:396]
      → POST /api/chat [api/chat/route:371]
        → ChatRequestSchema.parse(body)
        → buildTools (skills + MCP)
        → resolveAttachments
        → buildSystemPrompt
        → streamText(model, { system, messages, tools })
        → SSE ReadableStream [api/chat/route:549]
          → frames: text | reasoning | tool_call | tool_result
          | tool_image | suggestions | error | done
    ← SSE parsed in chat.tsx:827– (while-loop over reader)
      → appendToMessage / appendToMessageReasoning
      → tool_calls → setLiveToolCalls → ToolCallStrip renders
      → tool_image → appendMessageGeneratedImages → gallery renders
      → done → finalize message, autoArchiveCodeBlocks
```

### 9.2 File Upload & Extraction

```
Drop/Select → processSelectedFiles (validates size/ext)
  → addFile(meta) → store.files[]
  → addResource / addConversationFile (depending on context)
  → runExtraction(fileId, source, setFileExtraction):
    → POST /api/extract (server extracts text)
    → setFileExtraction(fileId, { extractionStatus, extractedText })
    → summariseFileInBackground (POST /api/summarize, if text > 500 chars)
  → persistFile (signed-in: Supabase Storage; anon: IndexedDB)
```

### 9.3 Cloud Sync

```
useSync() [use-sync:1] — mounted once in dashboard
  → store subscribe → take snapshot → diff prev vs next
    → handlers.ts: diffWorkspaces, diffConversations, diffMessages, ...
    → sync-queue.ts: enqueue SyncOp[], exponential backoff flush
      → Supabase PostgREST upserts/deletes (16 tables)

useReconcile() [use-reconcile:1]
  → First sign-in: prompt dialog (cloud vs local)
  → Returning sign-in: silent pull from cloud → applyCloudSnapshot
  → Online event: wait for queue drain → re-pull
```

---

## 10. API Layer

### 10.1 Client

`lib/client/api-client.ts:394` — the single entry point for all frontend
→ backend communication. Components must never `fetch('/api/...')`
directly.

| Method | Endpoint | SSE? | Response validated by |
|---|---|---|---|
| `apiClient.chat.stream(body)` | `POST /api/chat` | Yes | Manual SSE parsing |
| `apiClient.extract(file)` | `POST /api/extract` | No | `ExtractionResponseSchema` |
| `apiClient.summarize.file(body)` | `POST /api/summarize` | No | `FileSummarizeResponseSchema` |
| `apiClient.summarize.conversation(body)` | `POST /api/summarize` | No | `ConversationSummarizeResponseSchema` |
| `apiClient.summarize.compress(body)` | `POST /api/summarize` | No | `CompressSummarizeResponseSchema` |
| `apiClient.share.create(body)` | `POST /api/share` | No | `CreateShareResponseSchema` |
| `apiClient.share.revoke(token)` | `DELETE /api/share/<token>` | No | `RevokeShareResponseSchema` |
| `apiClient.mcp.proxy(action, body)` | `POST /api/mcp/<id>/<action>` | No | Manual |
| `apiClient.mcp.upsertCloudServer(body)` | `POST /api/mcp/server` | No | Manual |
| `apiClient.url.fetch(url)` | `POST /api/url/fetch` | No | Manual |

**Base URL:** Configurable via `NEXT_PUBLIC_API_BASE_URL` (default:
empty = same origin). Enables future backend language swap without code
changes.

### 10.2 Schemas

`lib/shared/api-schemas.ts` (368 lines) — Zod schemas for all request &
response shapes. 15+ schemas including: `ChatRequestSchema`,
`CopilotRequestSchema`, `ExtractionResponseSchema`, `SummarizeRequestSchema`
(discriminated on `mode`), `CreateShareRequestSchema` (discriminated on
`kind`), `ErrorResponseSchema`.

### 10.3 SSE Protocol

See `docs/API.md` (248 lines) for the full wire spec. Frame types:

| Type | Shape | Trigger |
|---|---|---|
| `text` | `{ type, value: string }` | Incremental assistant text |
| `reasoning` | `{ type, value: string }` | Reasoning tokens (R1, Claude thinking) |
| `tool_call` | `{ type, id, name, args }` | Model invoked a tool |
| `tool_result` | `{ type, id, name, summary, results? }` | Tool completed |
| `tool_image` | `{ type, id, mode, images[] }` | Image gen persisted |
| `suggestions` | `{ type, values: string[] }` | Follow-up questions (sent once) |
| `error` | `{ type, code, message }` | Terminal error |
| `done` | `{ type: "done" }` | Stream end |

Parsing: `chat.tsx:827–` uses a `while(true)` loop reading the SSE
`ReadableStream`, dispatching per-type.

---

## 11. Server-Side Architecture

### 11.1 Chat Route

`app/api/chat/route.ts:371` (904 lines) — the main SSE endpoint.

1. Validate body via `ChatRequestSchema`
2. Build tools from `SERVER_SKILLS` registry + MCP server list
3. Resolve attachments (files, MCP resources, URL bookmarks)
4. Build system prompt (workspace prompt + skill prompts + attachment
   blocks, 300KB budget)
5. `streamText()` with abort signal, model, tools
6. Emit SSE frames from `result.fullStream`
7. After stream: generate follow-up suggestions (Gemini Flash)
8. Emit `done` or `error`

**Rate limits:** web tools 20/min/IP, image gen configurable (default 5/min).
**Idle watchdog:** 90s silence → abort.
**Step budget:** 6 steps (skills only) or 10 steps (with MCP).

### 11.2 Skills Registry

`lib/server/skills/registry.ts` (81 lines) — `SERVER_SKILLS` array.
Four skills shipped:

| Skill | Tool name | File | Lines |
|---|---|---|---|
| Web Search | `webSearch` | `skills/web-search.ts` | 660 |
| Web Fetch | `webFetch` | `skills/web-fetch.ts` | 185 |
| Image Generation | `generateImage` | `skills/image-gen.ts` | 280 |
| File Search | `searchFiles` | `skills/file-search.ts` | 326 |

### 11.3 MCP Layer

`lib/server/mcp/` — 7 files.
- `client.ts` — Thin SDK wrapper: discover, callTool, readResource
- `tools.ts` — Builds AI SDK tool from MCP descriptor
- `credentials.ts` — Encryption/decryption via pgcrypto SECURITY DEFINER RPCs
- `load-servers.ts` — Merges local-mode + cloud-mode servers
- `inject-resources.ts` — Concurrent resource resolution (5s timeout each)

### 11.4 Other Server Modules

| Module | Purpose |
|---|---|
| `model-provider.ts` | Resolves model ID → AI SDK LanguageModel |
| `providers-config.ts` | Loads `config/providers.json`, credential resolution |
| `rate-limit.ts` | Sliding-window per-IP rate limiter |
| `image-storage.ts` | Persists generated images (Supabase Storage or data URL) |
| `url/fetch.ts` | SSRF-protected URL fetcher (10s timeout, HTML extraction) |
| `attachments/render.ts` | Renders attachments into system prompt (300KB budget) |
| `share/resolve.ts` | Public share page resolver |

---

## 12. Theme & Styling

- **Framework:** Tailwind CSS 4 (CSS-first config in `app/globals.css`)
- **Dark mode:** Class-based (`@custom-variant dark (&:is(.dark *))`)
- **Fonts:** Manrope (sans) + Geist Mono (mono) via `next/font/google`
- **UI components:** shadcn/ui (131 files in `components/ui/`)
- **Class merging:** `cn()` from `lib/shared/utils.ts` (clsx + tailwind-merge)
- **Theme bootstrap:** Inline `<script>` in `app/layout.tsx:27` reads
  `localStorage['hummingbird-storage'].state.theme` and toggles `.dark`
  before React hydrates → no flash
- **Theme switcher:** Now integrated into `AccountMenu`
  (`components/auth/account-menu.tsx`). Light/Dark/System toggles +
  color scheme selector (Default / Anthropic). Dispatches `setTheme()`
  and `setColorScheme()` to the store.
- **Color schemes:** `Default` (neutral gray) and `Anthropic` (warm orange/black/white).
  Controlled by `.anthropic` class on `<html>`. CSS overrides in `app/globals.css`
  under `.anthropic` and `.anthropic.dark` blocks.
- **`ThemeApplier`:** Syncs `.dark` and `.anthropic` classes on `<html>`,
  watches `prefers-color-scheme` for system mode.
- **Store fields:** `theme` (`'dark' | 'light' | 'system'`) and
  `colorScheme` (`'default' | 'anthropic'`), both persisted.

---

## 13. Component Quick-Reference Index

### Panels (main area views)

| Component | File | Line | Size |
|---|---|---|---|
| ChatPanel | `components/panels/chat.tsx` | 66 | ~2100 lines |
| EditorPanel | `components/panels/editor.tsx` | 63 | 299 lines |
| WorkspacesPanel | `components/panels/workspaces.tsx` | 41 | 401 lines |
| ResourcePanel | `components/panels/sources.tsx` | 39 | 353 lines |

### Chat sub-components

| Component | File | Line |
|---|---|---|
| ChatHeader | `components/panels/chat-header.tsx` | 77 |
| ChatMessage (memo) | `components/panels/chat-message.tsx` | 624 |
| ContextMeter | `components/panels/context-meter.tsx` | 44 |
| ContextPicker | `components/chat/context-picker.tsx` | 64 |
| SlashAutocomplete | `components/panels/slash-autocomplete.tsx` | 37 |
| ReasoningBlock | `components/panels/reasoning-block.tsx` | 1 |
| SourcesStrip | `components/panels/sources-strip.tsx` | 1 |
| ErrorBubble | `components/panels/error-bubble.tsx` | 1 |
| MessageAttachments | `components/panels/message-attachments.tsx` | 1 |
| CompressButton | `components/chat/compress-button.tsx` | 1 |
| SmartPasteChip | `components/chat/smart-paste-chip.tsx` | 1 |
| EmptyChatWelcome | `components/panels/empty-chat-welcome.tsx` | 1 |

### Sidebars

| Component | File | Line |
|---|---|---|
| AppSidebar | `components/sidebars/application.tsx` | 40 |
| ResourcesSidebar | `components/sidebars/resources.tsx` | 71 |
| ChatResourcesPanel | `components/panels/chat-resources-panel.tsx` | 43 |
| ConversationItem | `components/sidebars/conversation-item.tsx` | 1 |
| DocumentItem | `components/sidebars/document-item.tsx` | 1 |
| PromptItem | `components/sidebars/prompt-item.tsx` | 1 |
| ResourcesMobileDrawer | `components/sidebars/resources-mobile-drawer.tsx` | 1 |

### Right-panel tab bodies

| Component | File | Line |
|---|---|---|
| FilesTabBody | `components/panels/files-tab-body.tsx` | 1 |
| NotesTab | `components/panels/notes-tab.tsx` | 1 |
| ArtifactsTab | `components/panels/artifacts-tab.tsx` | 1 |
| PinsTab | `components/panels/pins-tab.tsx` | 1 |
| SkillsTab | `components/panels/skills-tab.tsx` | 70 |
| McpTab | `components/panels/mcp-tab.tsx` | 1 |
| UrlBookmarksTab | `components/panels/url-bookmarks-tab.tsx` | 1 |

### Skills UI

| Component | File | Line |
|---|---|---|
| ActiveSkillsChips | `components/skills/active-chips.tsx` | 31 |
| ToolCallStrip | `components/skills/tool-call-strip.tsx` | 1 |
| GeneratedImagesGallery | `components/skills/generated-images-gallery.tsx` | 1 |

### Editor

| Component | File | Line |
|---|---|---|
| PlateEditor (standalone) | `components/editor/plate-editor.tsx` | 1 |
| EditorKit | `components/editor/editor-kit.ts` | 1 |
| AiReviewPill | `components/editor/ai-review-pill.tsx` | 1 |
| AiReviewKeymap | `components/editor/ai-review-keymap.tsx` | 1 |

### Overlays & Dialogs

| Component | File | Line |
|---|---|---|
| CommandPalette | `components/command-palette.tsx` | 63 |
| ShareDialog | `components/share-dialog.tsx` | 1 |
| BranchesDialog | `components/branches-dialog.tsx` | 1 |
| ConversationSummaryDialog| `components/conversation-summary-dialog.tsx` | 1 |
| PromptDialog | `components/panels/prompt-dialog.tsx` | 1 |
| PromptVariableFill | `components/panels/prompt-variable-fill.tsx` | 1 |
| SaveArtifactDialog | `components/panels/save-artifact-dialog.tsx` | 1 |
| SlashHelpDialog | `components/panels/slash-help-dialog.tsx` | 1 |

### Auth & Settings

| Component | File | Line |
|---|---|---|
| AccountMenu | `components/auth/account-menu.tsx` | 1 |
| AuthDialog | `components/auth/auth-dialog.tsx` | 1 |
| ReconcileDialog | `components/auth/reconcile-dialog.tsx` | 1 |

### Viewers (right-panel slot)

| Component | File |
|---|---|
| PdfViewerHost | `components/pdf-viewer/` |
| UrlPreviewHost | `components/url-viewer/` |
| LiveArtifactHost | `components/live-artifact/` |
| ImageViewerHost | `components/image-viewer/` |
| DocxViewerHost | `components/docx-viewer/` |
| TextViewerHost | `components/text-viewer/` |
| CsvViewerHost | `components/csv-viewer/` |

### Selection actions

| Component | File |
|---|---|
| SelectionTrigger | `components/selection/selection-trigger.tsx` |
| SelectionToolbar | `components/selection/selection-toolbar.tsx` |
| ExplainPopover | `components/selection/explain-popover.tsx` |
| ExplainSheet | `components/selection/explain-sheet.tsx` |

### Markdown & Code

| Component | File |
|---|---|
| MarkdownPreview | `components/markdown-preview.tsx` |
| CodeHighlight | `components/code-highlight.tsx` |

### UI Primitives (shadcn/ui — 131 files)

`components/ui/` — alert-dialog, avatar, breadcrumb, button, calendar,
checkbox, collapsible, command, context-menu, dialog, dropdown-menu,
hover-card, input, input-group, item, popover, resizable, scroll-area,
select, separator, sheet, sidebar, skeleton, switch, textarea, tooltip,
sonner (Toaster).

---

## 14. Key File Index

### Layout & Shell

| Path | Purpose |
|---|---|
| `app/layout.tsx` | Root layout: fonts, theme bootstrap script, TooltipProvider |
| `app/page.tsx` | Re-exports `app/dashboard/page.tsx` |
| `app/dashboard/page.tsx` | Dashboard shell: SidebarProvider, AppSidebar, MainArea, overlays, toaster |
| `app/globals.css` | Tailwind 4 config, CSS variables, animations |

### State

| Path | Purpose |
|---|---|
| `lib/client/hooks/use-store.ts` | Zustand store (3151 lines): 16 slices, 200+ actions, 20+ selectors |
| `lib/client/hooks/use-sync.ts` | Sync orchestrator: snapshot diff → enqueue |
| `lib/client/hooks/use-reconcile.ts` | Reconciliation: cloud pull, prompt dialog |
| `lib/client/hooks/use-auth.ts` | Supabase auth hook |
| `lib/client/hooks/use-attached-context.ts` | Resolves merged attachment list for active conv |
| `lib/client/hooks/use-slash-commands.ts` | Client-side slash command registry |
| `lib/client/hooks/use-selection.ts` | Text selection tracking |
| `lib/client/hooks/use-explain-stream.ts` | Streaming explain-content lifecycle |

### Data Layer

| Path | Purpose |
|---|---|
| `lib/client/api-client.ts` | Typed API client: 10 URL builders, 9 methods |
| `lib/shared/api-schemas.ts` | Zod schemas: 15+ request/response validators |
| `lib/shared/types.ts` | Core TypeScript types |
| `lib/client/sync/sync-queue.ts` | Background sync queue with backoff |
| `lib/client/sync/handlers.ts` | Snapshot diff → SyncOp producers (16 entities) |
| `lib/client/sync/reconcile.ts` | Cloud snapshot fetch, bulk upload, apply |
| `lib/client/extract.ts` | File extraction pipeline (upload → extract → summarize) |

### Server

| Path | Purpose |
|---|---|
| `app/api/chat/route.ts` | Main SSE chat endpoint (904 lines) |
| `app/api/extract/route.ts` | File text extraction |
| `app/api/summarize/route.ts` | Summarization (file/conversation/compress modes) |
| `app/api/ai/command/route.ts` | Plate.js AI command |
| `app/api/ai/copilot/route.ts` | Plate.js AI copilot |
| `app/api/share/route.ts` | Share link mint |
| `app/api/url/fetch/route.ts` | URL fetch + bookmark |
| `app/api/mcp/**` | MCP server management + proxy |
| `lib/server/model-provider.ts` | Model resolution |
| `lib/server/skills/` | 4 server skills (webSearch, webFetch, imageGen, searchFiles) |
| `lib/server/mcp/` | MCP client, tools, credentials, load-servers |

### Shared

| Path | Purpose |
|---|---|
| `lib/shared/models.ts` | Model registry (from `config/models.json`) |
| `lib/shared/tokens.ts` | Token counting (chars/4 heuristic) |
| `lib/shared/compression.ts` | Message compression algorithm |
| `lib/shared/skills/` | Client-side skill types, registry, slash parser, config |
| `lib/shared/prompts/` | Prompt template mention parser, expander |
| `lib/shared/smart-paste/` | Paste content detection + actions |
| `lib/shared/supabase/` | Supabase env validation + generated DB types |
