<!-- pages-for: shortcut:* -->
<!-- related: components/help-popover.tsx, components/command-palette.tsx -->

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
| `Enter` | Send the chat message |
| `Shift+Enter` | New line in the chat input |
| `Esc` | Close dialogs / cancel editing |

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
