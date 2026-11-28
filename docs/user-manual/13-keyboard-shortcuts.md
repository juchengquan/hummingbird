<!-- pages-for: shortcut:*, panel:conversation-find-bar -->
<!-- related: apps/web/components/help-popover.tsx, apps/web/components/command-palette.tsx, apps/web/components/panels/conversation-find-bar.tsx -->

# Keyboard shortcuts

## What it is
The full set of keyboard shortcuts. The in-app **?** help popover
shows the most-used ones; this page is the complete list.

## How to open it
- The **?** help icon in the chat header opens a popover with the
  core shortcuts.
- `Ctrl+K` (or `Cmd+K` on macOS) opens the command palette - type to
  search every action.

## Global

| Shortcut | Action |
|---|---|
| `Ctrl+K` / `Cmd+K` | Open the command palette |
| `Ctrl+F` / `Cmd+F` | Find in the open conversation (see below) |
| `Enter` | Send the chat message |
| `Shift+Enter` | New line in the chat input |
| `Esc` | Close dialogs / cancel editing |

## Find in conversation

`Ctrl+F` / `Cmd+F` in an open chat opens a find bar over the messages
instead of the browser's own find. Every match in the visible message
text is highlighted; the active one is shown in a stronger colour with a
`current / total` count.

| Shortcut | Action |
|---|---|
| `Enter` | Next match (wraps to the first) |
| `Shift+Enter` | Previous match (wraps to the last) |
| `Esc` | Close the find bar and clear the highlights |

- Select text in a message first and the find bar opens with it filled in.
- Matching ignores case. There's no regex, whole-word or replace.
- Only text you can see is searched: collapsed reasoning is skipped until
  you expand it (then type again to re-search).
- New messages and streaming replies are picked up while the bar is open.
- Outside the chat view, or in an empty chat, `Ctrl+F` / `Cmd+F` is left
  to the browser.
- Browsers without the CSS Custom Highlight API get a simpler version:
  the bar jumps between whole messages that match and briefly outlines
  each one, and the count is of messages, not matches.

## Selection-driven

| Shortcut | Action |
|---|---|
| `Cmd+E` / `Ctrl+E` | Explain the current selection (from the command palette) |
| `Cmd+Enter` / `Ctrl+Enter` | Pin an explanation (from the explain popover) |

## Tips & gotchas
- The editor has its own keymap (Plate.js): `Cmd+B` / `Ctrl+B` bold,
  `Cmd+I` / `Ctrl+I` italic, `Cmd+E` / `Ctrl+E` code, `Cmd+J` / `Ctrl+J`
  AI menu, etc. These conflict with the global selection shortcuts
  only when the editor is focused.

## Related
- [Settings & theme](12-settings-and-theme.md)
- [Editor](03-editor.md)
