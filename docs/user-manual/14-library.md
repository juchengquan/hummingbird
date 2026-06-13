<!-- pages-for: panel:library -->
<!-- related: components/panels/library.tsx, lib/client/hooks/store/slices/artifacts.ts -->

# Library

## What it is
A workspace-scoped, cross-conversation index of **generated artifacts**:
images the model produced, code snippets you archived, and any other
artifact saved from a conversation. The file library is a separate
surface (see [Files & attachments](04-files-and-attachments.md)); the
Library panel is for outputs the model made for you, not inputs you
uploaded.

## How to open it
The **Library** entry in the left sidebar (under the workspace
selector).

## What you can do
- Browse every generated image and saved artifact across every
  conversation in the workspace.
- Click a row to view the artifact (image, code, etc.).
- Re-attach an artifact to a new conversation (if the surface
  exposes it).
- Filter by type (image, code, text) and date.

## Tips & gotchas
- The Library is per-workspace. Switch workspaces to see a different
  set of artifacts.
- The Library index is built from saved artifacts. If you didn't
  explicitly archive a model output, it won't appear here even if
  it was generated in a chat.

## Related
- [Chat](02-chat.md)
- [Files & attachments](04-files-and-attachments.md)
