<!-- pages-for: sidebar:conversation-item, sidebar:document-item, sidebar:prompt-item -->
<!-- related: components/sidebars/conversation-item.tsx, components/sidebars/document-item.tsx, components/sidebars/prompt-item.tsx, lib/client/hooks/store/slices/conversations.ts, lib/client/hooks/store/slices/workspaces.ts -->

# Conversations & workspaces

## What it is
The two top-level organizational units. Workspaces hold conversations,
files, documents, prompts, and notes. Conversations hold the message
history of a single chat.

## How to open it
- The **Workspaces** tab in the main view (the default landing page).
- The **Chats** group in the left sidebar - collapsed by default,
  click to expand.
- The **+** next to **Chats** starts a new conversation in the active
  workspace.

## What you can do
- **Workspaces**: create from the main view; rename, delete, or
  switch via the sidebar's quick-switch popover (the chevron next to
  the workspace name).
- **Conversations**: create, rename, pin, delete, or re-open. Pinned
  conversations stay at the top of the list.
- **Workspaces have a system prompt** - set it on the Workspaces
  detail sheet to give every conversation in the workspace a custom
  default tone, role, or context.
- Each conversation can have its own system prompt that **overrides**
  the workspace's. Edit it from the chat header.

## Tips & gotchas
- Deleting a workspace cascades to every conversation, file, document,
  and note inside it. There is no undo.
- Switching workspaces changes the active conversation and the file
  library. The chat composer keeps any draft text in memory.
- Pinning a conversation moves it to the top of the list - useful
  for in-progress chats you keep coming back to.

## Related
- [Prompt library](10-prompt-library.md)
- [Notes & bookmarks](11-notes-and-bookmarks.md)
- [Settings & theme](12-settings-and-theme.md)
