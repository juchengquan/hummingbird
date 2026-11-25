<!-- pages-for: panel:editor -->
<!-- related: components/panels/editor.tsx, components/editor/, lib/shared/markdown-joiner-transform.ts -->

# Editor

## What it is
A rich-text document editor (powered by Plate.js). Use it for notes,
drafts, or long-form writing. Documents live inside a workspace and
sync across devices when you sign in.

## How to open it
The **Editor** entry in the left sidebar opens a new document, or
click any document in the **Documents** section of a workspace to
open an existing one.

## What you can do
- Format text with the toolbar: bold, italic, code, headings, lists.
- Drop in images, code blocks, and tables from the **+** menu.
- Type `/` to open the editor's slash-command menu (different from
  the chat slash menu - this one inserts blocks).
- Use the AI menu (**Ctrl+J**) inside a selection to ask the model to
  rewrite, expand, or summarize.
- Toggle **AI review changes** in [Settings](12-settings-and-theme.md)
  to control whether AI edits land as suggestions (default) or replace
  your text directly.
- With the **agent-py** or **agent-py (runs)** backend selected, the
  editor's AI menu and ghost-text suggestions run on agent-py too. The
  editor's own settings (the gear at the bottom right) then offer only
  the models agent-py runs; typing your own AI Gateway key there keeps
  the editor on the built-in route, which bills that key.

## Tips & gotchas
- Documents are auto-saved. There's no save button by design.
- The editor's AI menu only fires when text is selected. Press
  **Esc** first if a popover is open.
- Markdown round-trip: copy a markdown document into the editor and
  it'll be parsed into blocks. Copy from the editor and paste into
  another markdown surface to round-trip.

## Related
- [Settings & theme](12-settings-and-theme.md)
- [Chat](02-chat.md)
