<!-- pages-for: panel:sources -->
<!-- related: components/panels/sources.tsx, lib/client/file-utils.tsx, app/api/extract/ -->

# Files & attachments

## What it is
A workspace-scoped file library plus per-conversation attachments.
Files you upload live in the workspace; files you attach live on a
single conversation and are usually a subset of the workspace library.

## How to open it
- The **Files** tab on the right rail (in the chat view) shows the
  current workspace's files.
- The **+** button on the right rail opens the upload dialog.
- Drag a file onto the chat input to upload and attach in one step.
- Use the **Files** entry in the left sidebar to see a workspace-
  scoped file list at any time.

## What you can do
- Upload files: drag-and-drop, click **+**, or paste from the
  clipboard. Supported types include PDF, Word, Excel, images, code,
  and plain text.
- Search the workspace's files by name from the search box.
- Hover a file row to see its full-text extraction status, size, and
  type.
- Check the boxes next to files to attach them to the active
  conversation. Attachments appear as chips above the chat input.
- Toggle a per-attached-file setting between **inline** (full content
  in the prompt) and **RAG** (model pulls from full text on demand).

## Tips & gotchas
- Large PDFs and code repositories can take a few seconds to extract
  the first time. The extraction status badge on each row shows
  progress.
- `searchFiles` (the `/files` skill) requires sign-in - full text is
  stored in Supabase. Without it, only inline content is available to
  the model.
- Deleting a file removes it from the workspace and from any
  conversation that referenced it. This is permanent.

## Related
- [Skills & tools](07-skills-and-tools.md)
- [Chat](02-chat.md)
