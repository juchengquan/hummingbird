<!-- pages-for: panel:notes-tab, panel:pins-tab, panel:url-bookmarks-tab, panel:artifacts-tab -->
<!-- related: components/panels/notes-tab.tsx, components/panels/pins-tab.tsx, components/panels/url-bookmarks-tab.tsx, components/panels/artifacts-tab.tsx -->

# Notes, pins, bookmarks & artifacts

## What it is
Four related surfaces for capturing outputs and saving references,
all in the right rail of the chat view.

## What you can do

### Notes (`Notes` tab)
Free-form notes scoped to a workspace. Use them for scratch work,
research digests, or any text you want kept alongside your chats.

### Pins (`Pins` tab)
Pinned explanations from the selection-driven **Explain** action
(Ctrl+E or the selection menu). Pins are per-conversation and vanish
on reload by design.

### Bookmarks (`Links` tab)
Saved URLs, with optional title and note. Drop a URL into a
conversation and pick "bookmark" to capture it for later.

### Artifacts (`Artifacts` tab)
Saved code or markdown snippets from assistant messages. Hover an
assistant message -> archive icon to save a snippet here.

## Tips & gotchas
- Pins are session-only - refreshing the page clears them. Save the
  valuable ones to Notes if you need them to survive a reload.
- Bookmarks are workspace-scoped. Move a workspace, move its
  bookmarks with it.
- Artifacts are conversation-scoped. Save the valuable ones to
  Notes to keep them across conversations.

## Related
- [Chat](02-chat.md)
- [Prompt library](10-prompt-library.md)
