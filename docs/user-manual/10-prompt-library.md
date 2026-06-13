<!-- pages-for: panel:prompt-dialog -->
<!-- related: components/panels/prompt-dialog.tsx, components/sidebars/prompt-item.tsx, lib/client/hooks/store/slices/prompts.ts -->

# Prompt library

## What it is
A workspace-scoped library of reusable prompt templates. Drop
typed variables (`{{name}}`) into a prompt once, fill them in per
use, and the filled prompt seeds the chat composer.

## How to open it
- The **Prompts** section in the left sidebar (under a workspace).
- The **+** next to **Prompts** creates a new prompt.
- Clicking a prompt in the sidebar opens the variable-fill dialog.

## What you can do
- Create a prompt with a name, body, and any number of
  `{{variable}}` placeholders.
- Edit, rename, or delete a prompt from its sidebar row.
- Click a prompt to fill its variables; the result is copied into
  the chat composer of the active conversation.
- Promote a frequently-used chat snippet into a prompt from the
  composer menu (if exposed by the deployment).

## Tips & gotchas
- Variables are case-sensitive: `{{Name}}` and `{{name}}` are
  different.
- If a prompt body contains un-matched braces, the variable-fill
  dialog flags them and refuses to fill.

## Related
- [Chat](02-chat.md)
- [Notes & bookmarks](11-notes-and-bookmarks.md)
