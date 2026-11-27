<!-- pages-for: setting:theme, setting:colorScheme, setting:localOnlyMode, setting:localFilesOnly, setting:editorPrefs.aiReviewChanges -->
<!-- related: lib/client/hooks/store/slices/ui.ts, components/auth/account-menu.tsx -->

# Settings & theme

## What it is
Per-user preferences. Most settings live in the account menu (top
right of the left sidebar) and persist across reloads.

## How to open it
Click your avatar or initial at the bottom of the left sidebar.

## What you can do

### Theme & appearance
- **Theme** - `system` (follow the OS), `dark`, or `light`. Default
  is `dark`. The change is applied instantly; no reload.
- **Color scheme** - `default` or `anthropic`. Affects accent
  colours.

### Privacy
- **Local-only mode** - when on, behave as if Supabase isn't
  configured: no sync, no sign-in flows, no reconcile pulls. Survives
  reloads. Changes you make while it's on stay on this device and are
  uploaded when you turn cloud sync back on (your local edits win over
  the cloud copy; things you deleted while paused are deleted in the
  cloud too). The same applies when you sign out and later sign back
  in as the same account. Signing in as a *different* account never
  uploads them — you get the usual keep-local / keep-cloud prompt.
- **Local files only** - when on, raw file blobs stay in IndexedDB
  instead of being uploaded to Supabase Storage. Extracted text and
  metadata still sync (it's small).

### Editor
- **AI review changes** - when on (default), AI `edit`-mode output
  lands as Plate suggestion marks you accept/reject per chunk. When
  off, the AI's output replaces the selected text directly.
- **Editor AI model** (the gear at the editor's bottom right) - the
  model the editor's AI menu and ghost text use, from this deploy's
  models. There is no personal AI Gateway key setting any more: the
  editor always runs on the deploy's keys (a one-time note says so the
  first time you open it).

### Chat and models
There is no backend setting any more: chat always runs on the deploy's
agent service (agent-py, on its runs API `/v1/runs`). A browser that had
picked another backend sees one note, "Chat now runs on agent-py. The
backend setting was removed." Stop cancels the answer on the server;
closing or reloading the tab doesn't - after a reload the running answer
is picked back up into its message. When the assistant needs your input
mid-answer (an approval or a question), the answer pauses until you
reply; typing a new message instead cancels the paused one.

- **Models.** The agent service runs the models its deploy has a
  provider key for - Anthropic, MiniMax, the AI Gateway's, OpenRouter's,
  Ollama's - and tells the browser which ones. The model picker lists
  just those, and a model it can't run is switched to one it can, with a
  note saying so. Auto is offered when both models of the routing pair
  run there (it routes each message between them, and the reply shows
  which one it used).
- **No model provider.** If the deploy has no model provider key at
  all, the model picker and the chat say "No model provider is
  configured on this deploy" and sending is blocked (with a pointer to
  [Model providers](23-model-providers.md)) - there is no stand-in
  answer. An admin adds a provider key for agent-py to fix it.

## Tips & gotchas
- Local-only mode is sticky - once on, you'll need to flip it off
  to sign back in.

## Related
- [Editor](03-editor.md)
- [Chat](02-chat.md)
- [Environment variables](21-environment-variables.md)
