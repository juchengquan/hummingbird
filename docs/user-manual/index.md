# Hummingbird - User Manual

> Generated TOC. Last inventory: 2026-06-13. Run `bun run docs:user-manual:build` to refresh.

## Part 1 - Using Hummingbird

- [Getting Started](01-getting-started.md)
- [Chat](02-chat.md)
- [Editor](03-editor.md)
- [Files And Attachments](04-files-and-attachments.md)
- [Conversations And Workspaces](05-conversations-and-workspaces.md)
- [Slash Commands](06-slash-commands.md)
- [Agent Tasks](08-agent-tasks.md)
- [Canvas](09-canvas.md)

## Part 2 - Installing & Configuring

- [Environment Variables](21-environment-variables.md)

### Panels

| Panel | Source | Page |
|---|---|---|
| Agents Dialog | `components/panels/agents-dialog.tsx` | _unmapped_ |
| Artifacts Tab | `components/panels/artifacts-tab.tsx` | [11-notes-and-bookmarks.md](11-notes-and-bookmarks.md) |
| Canvas Panel | `components/panels/canvas.tsx` | [09-canvas.md](09-canvas.md) |
| Chat Panel | `components/panels/chat.tsx` | [02-chat.md](02-chat.md) |
| Chat Header | `components/panels/chat-header.tsx` | _unmapped_ |
| Chat Message | `components/panels/chat-message.tsx` | _unmapped_ |
| Chat Resources Panel | `components/panels/chat-resources-panel.tsx` | _unmapped_ |
| Context Meter | `components/panels/context-meter.tsx` | _unmapped_ |
| Conversation Files Section | `components/panels/conversation-files-section.tsx` | _unmapped_ |
| Editor Panel | `components/panels/editor.tsx` | [03-editor.md](03-editor.md) |
| Empty Chat Welcome | `components/panels/empty-chat-welcome.tsx` | _unmapped_ |
| Error Bubble | `components/panels/error-bubble.tsx` | _unmapped_ |
| Extraction Status Badge | `components/panels/extraction-status-badge.tsx` | _unmapped_ |
| File Availability Badge | `components/panels/file-availability-badge.tsx` | _unmapped_ |
| File Row Meta | `components/panels/file-row-meta.tsx` | _unmapped_ |
| Files Tab Body | `components/panels/files-tab-body.tsx` | _unmapped_ |
| Library Panel | `components/panels/library.tsx` | [14-library.md](14-library.md) |
| Mcp Tab | `components/panels/mcp-tab.tsx` | _unmapped_ |
| Message Attachments | `components/panels/message-attachments.tsx` | _unmapped_ |
| Message Verification | `components/panels/message-verification.tsx` | _unmapped_ |
| Notes Tab | `components/panels/notes-tab.tsx` | [11-notes-and-bookmarks.md](11-notes-and-bookmarks.md) |
| Pins Tab | `components/panels/pins-tab.tsx` | [11-notes-and-bookmarks.md](11-notes-and-bookmarks.md) |
| Project Tasks Panel | `components/panels/project-tasks-panel.tsx` | _unmapped_ |
| Prompt Dialog | `components/panels/prompt-dialog.tsx` | [10-prompt-library.md](10-prompt-library.md) |
| Prompt Variable Fill | `components/panels/prompt-variable-fill.tsx` | _unmapped_ |
| Reasoning Block | `components/panels/reasoning-block.tsx` | _unmapped_ |
| Save Artifact Dialog | `components/panels/save-artifact-dialog.tsx` | _unmapped_ |
| Schedule Section | `components/panels/schedule-section.tsx` | [15-schedules.md](15-schedules.md) |
| Skills Dialog | `components/panels/skills-dialog.tsx` | _unmapped_ |
| Skills Tab | `components/panels/skills-tab.tsx` | _unmapped_ |
| Slash Autocomplete | `components/panels/slash-autocomplete.tsx` | _unmapped_ |
| Slash Help Dialog | `components/panels/slash-help-dialog.tsx` | _unmapped_ |
| Resource Panel | `components/panels/sources.tsx` | [04-files-and-attachments.md](04-files-and-attachments.md) |
| Sources Strip | `components/panels/sources-strip.tsx` | _unmapped_ |
| Tab Empty State | `components/panels/tab-empty-state.tsx` | _unmapped_ |
| Url Bookmarks Tab | `components/panels/url-bookmarks-tab.tsx` | [11-notes-and-bookmarks.md](11-notes-and-bookmarks.md) |
| Workspace Detail Sheet | `components/panels/workspace-detail-sheet.tsx` | _unmapped_ |
| Workspace Mcp Section | `components/panels/workspace-mcp-section.tsx` | _unmapped_ |
| Workspace Row | `components/panels/workspace-row.tsx` | _unmapped_ |
| Workspaces Panel | `components/panels/workspaces.tsx` | [01-getting-started.md](01-getting-started.md) |

### Sidebars

| Sidebar | Source | Page |
|---|---|---|
| App Sidebar | `components/sidebars/application.tsx` | [01-getting-started.md](01-getting-started.md) |
| Conversation Item | `components/sidebars/conversation-item.tsx` | [05-conversations-and-workspaces.md](05-conversations-and-workspaces.md) |
| Document Item | `components/sidebars/document-item.tsx` | [05-conversations-and-workspaces.md](05-conversations-and-workspaces.md) |
| Prompt Item | `components/sidebars/prompt-item.tsx` | [05-conversations-and-workspaces.md](05-conversations-and-workspaces.md) |
| Resources Sidebar | `components/sidebars/resources.tsx` | [01-getting-started.md](01-getting-started.md) |
| Resources Mobile Drawer | `components/sidebars/resources-mobile-drawer.tsx` | _unmapped_ |
| Tasks Sidebar | `components/sidebars/tasks.tsx` | _unmapped_ |

### Slash commands

| Command | Description | Page |
|---|---|---|
| `/clear` | Remove every message in this chat | [06-slash-commands.md](06-slash-commands.md) |
| `/help` | List every / command and @ prompt trigger | [06-slash-commands.md](06-slash-commands.md) |
| `/model` | Pick a model, or open the picker | [06-slash-commands.md](06-slash-commands.md) |
| `/new` | Start a fresh chat in this workspace | [06-slash-commands.md](06-slash-commands.md) |
| `/personas` | Create, edit, and pin custom AI personas (`PLAN-custom-agents.md`) | [06-slash-commands.md](06-slash-commands.md) |
| `/rename` | Set this chat's title | [06-slash-commands.md](06-slash-commands.md) |
| `/skills` | Author, import, and toggle portable SKILL.md skills (`PLAN-portable-skills.md`) | _unmapped_ |

### Environment variables

| Variable | Required | Page |
|---|---|---|
| `AI_GATEWAY_API_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `ANTHROPIC_API_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `ANTHROPIC_BASE_URL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `BRAVE_SEARCH_API_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `EMBEDDINGS_API_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `EMBEDDINGS_BASE_URL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `EMBEDDINGS_MODEL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `EXA_API_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `GOOGLE_API_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `MCP_ENCRYPTION_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `MINIMAX_CN_API_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `MINIMAX_CN_BASE_URL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE` | no | [21-environment-variables.md](21-environment-variables.md) |
| `NEXT_PUBLIC_AGENT_PY_URL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `NEXT_PUBLIC_AGENT_TS_URL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `NEXT_PUBLIC_API_BASE_URL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `OLLAMA_API_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `OLLAMA_BASE_URL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `OPENROUTER_API_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `SUPABASE_DB_URL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `SUPABASE_JWT_SECRET` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `TAVILY_API_KEY` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `VERIFY_MODEL` | yes | [21-environment-variables.md](21-environment-variables.md) |
| `VERIFY_PROVIDER` | no | [21-environment-variables.md](21-environment-variables.md) |

### Settings

| Setting | Values | Page |
|---|---|---|
| Theme | system / dark / light | [12-settings-and-theme.md](12-settings-and-theme.md) |
| Color scheme | default / anthropic | [12-settings-and-theme.md](12-settings-and-theme.md) |
| Chat backend | ts / python / ts-service | [12-settings-and-theme.md](12-settings-and-theme.md) |
| Local-only mode | - | [12-settings-and-theme.md](12-settings-and-theme.md) |
| Local files only | - | [12-settings-and-theme.md](12-settings-and-theme.md) |
| AI review changes (editor) | - | [12-settings-and-theme.md](12-settings-and-theme.md) |

### Keyboard shortcuts

| Shortcut | Page |
|---|---|
| `⌘`+`K` - Command palette (or Ctrl+K) | [13-keyboard-shortcuts.md](13-keyboard-shortcuts.md) |
| `⏎` - Send message | [13-keyboard-shortcuts.md](13-keyboard-shortcuts.md) |
| `⇧`+`⏎` - New line in input | [13-keyboard-shortcuts.md](13-keyboard-shortcuts.md) |
| `Esc` - Close dialogs / cancel editing | [13-keyboard-shortcuts.md](13-keyboard-shortcuts.md) |

### Skills

| Skill | Slash trigger | Page |
|---|---|---|
| Image generation | `/image`, `/img` | [06-slash-commands.md](06-slash-commands.md) |
| File search | `/files`, `/file` | [06-slash-commands.md](06-slash-commands.md) |
| Web fetch | `/fetch`, `/f` | [06-slash-commands.md](06-slash-commands.md) |
| Web search | `/search`, `/s` | [06-slash-commands.md](06-slash-commands.md) |

### Agent task kinds

| Kind | Page |
|---|---|
| `approval` | [08-agent-tasks.md](08-agent-tasks.md) |
| `artifact_ref` | [08-agent-tasks.md](08-agent-tasks.md) |
| `compact` | [08-agent-tasks.md](08-agent-tasks.md) |
| `handoff` | [08-agent-tasks.md](08-agent-tasks.md) |
| `plan` | [08-agent-tasks.md](08-agent-tasks.md) |
| `result` | [08-agent-tasks.md](08-agent-tasks.md) |
| `status` | [08-agent-tasks.md](08-agent-tasks.md) |
| `step_end` | [08-agent-tasks.md](08-agent-tasks.md) |
| `step_error` | [08-agent-tasks.md](08-agent-tasks.md) |
| `step_start` | [08-agent-tasks.md](08-agent-tasks.md) |
| `token` | [08-agent-tasks.md](08-agent-tasks.md) |
| `tool_input` | [08-agent-tasks.md](08-agent-tasks.md) |
| `tool_output` | [08-agent-tasks.md](08-agent-tasks.md) |

## Unmapped (action needed)

> These inventory entries don't have a PAGE_MAP entry yet. Add a page that documents them and wire it up.

- `panel:agents-dialog` (`components/panels/agents-dialog.tsx`) - Agents Dialog
- `panel:chat-header` (`components/panels/chat-header.tsx`) - Chat Header
- `panel:chat-message` (`components/panels/chat-message.tsx`) - Chat Message
- `panel:chat-resources-panel` (`components/panels/chat-resources-panel.tsx`) - Chat Resources Panel
- `panel:context-meter` (`components/panels/context-meter.tsx`) - Context Meter
- `panel:conversation-files-section` (`components/panels/conversation-files-section.tsx`) - Conversation Files Section
- `panel:empty-chat-welcome` (`components/panels/empty-chat-welcome.tsx`) - Empty Chat Welcome
- `panel:error-bubble` (`components/panels/error-bubble.tsx`) - Error Bubble
- `panel:extraction-status-badge` (`components/panels/extraction-status-badge.tsx`) - Extraction Status Badge
- `panel:file-availability-badge` (`components/panels/file-availability-badge.tsx`) - File Availability Badge
- `panel:file-row-meta` (`components/panels/file-row-meta.tsx`) - File Row Meta
- `panel:files-tab-body` (`components/panels/files-tab-body.tsx`) - Files Tab Body
- `panel:mcp-tab` (`components/panels/mcp-tab.tsx`) - Mcp Tab
- `panel:message-attachments` (`components/panels/message-attachments.tsx`) - Message Attachments
- `panel:message-verification` (`components/panels/message-verification.tsx`) - Message Verification
- `panel:project-tasks-panel` (`components/panels/project-tasks-panel.tsx`) - Project Tasks Panel
- `panel:prompt-variable-fill` (`components/panels/prompt-variable-fill.tsx`) - Prompt Variable Fill
- `panel:reasoning-block` (`components/panels/reasoning-block.tsx`) - Reasoning Block
- `panel:save-artifact-dialog` (`components/panels/save-artifact-dialog.tsx`) - Save Artifact Dialog
- `panel:skills-dialog` (`components/panels/skills-dialog.tsx`) - Skills Dialog
- `panel:skills-tab` (`components/panels/skills-tab.tsx`) - Skills Tab
- `panel:slash-autocomplete` (`components/panels/slash-autocomplete.tsx`) - Slash Autocomplete
- `panel:slash-help-dialog` (`components/panels/slash-help-dialog.tsx`) - Slash Help Dialog
- `panel:sources-strip` (`components/panels/sources-strip.tsx`) - Sources Strip
- `panel:tab-empty-state` (`components/panels/tab-empty-state.tsx`) - Tab Empty State
- `panel:workspace-detail-sheet` (`components/panels/workspace-detail-sheet.tsx`) - Workspace Detail Sheet
- `panel:workspace-mcp-section` (`components/panels/workspace-mcp-section.tsx`) - Workspace Mcp Section
- `panel:workspace-row` (`components/panels/workspace-row.tsx`) - Workspace Row
- `sidebar:resources-mobile-drawer` (`components/sidebars/resources-mobile-drawer.tsx`) - Resources Mobile Drawer
- `sidebar:tasks` (`components/sidebars/tasks.tsx`) - Tasks Sidebar
- `slash:skills` (`lib/shared/commands/registry.ts`) - `/skills` Manage skills
