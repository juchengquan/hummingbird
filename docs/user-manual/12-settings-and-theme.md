<!-- pages-for: setting:theme, setting:colorScheme, setting:chatBackend, setting:localOnlyMode, setting:localFilesOnly, setting:editorPrefs.aiReviewChanges -->
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

### Backend
- **Chat backend** - pick the user-facing chat producer. Options:
  - `ts` (default) - the Next.js `/api/chat` route.
  - `python` - the Python agent service at
    `${NEXT_PUBLIC_AGENT_PY_URL}/v1/chat` (only shows when the env
    var is set).
  - `ts-service` - the TypeScript agent service (Phase 5+; shows
    when `NEXT_PUBLIC_AGENT_TS_URL` is set).
  - `python-runs` - **agent-py (runs)**, experimental: chat turns run
    on the agent-py runs API (`/v1/runs`). Stop cancels the answer on
    the server; closing or reloading the tab doesn't — after a reload
    the running answer is picked back up into its message. When the
    assistant needs your input mid-answer (an approval or a question),
    the answer pauses until you reply; typing a new message instead
    cancels the paused one. Also offered to signed-out users (shows
    when `NEXT_PUBLIC_AGENT_PY_URL` is set). Attached files, MCP
    resources and URL bookmarks reach the model as they do on the
    default backend (signed in, files go by reference — the server reads
    your synced copy, including RAG-mode files through file search), and
    so do the reasoning-effort setting, reference images and the
    workspace's local-mode MCP servers (their credentials go with each
    answer and the server never stores them; MCP App panels render as
    on `ts`). The code interpreter is not available yet. Every
    other request (summaries, embeds, sharing, …) goes exactly where
    `python` sends it.
- **Models per backend.** The agent services (`python` and `ts-service`
  when signed in, `python-runs` always) only run the Anthropic models,
  so while one of them serves chat the model picker lists just those,
  and a model they can't run is switched to one they can, with a note
  saying so. Auto is offered on `python-runs` (it routes each message
  between the two Anthropic models of the routing pair, and the reply
  shows which one it used) but not on `python` or `ts-service`.
  Switching back to `ts` brings the full list back.

## Tips & gotchas
- The Chat backend toggle is only visible when the corresponding
  env var is set on the server. Without it, every value here is
  silently treated as `ts`.
- Local-only mode is sticky - once on, you'll need to flip it off
  to sign back in.

## Related
- [Editor](03-editor.md)
- [Chat](02-chat.md)
- [Environment variables](21-environment-variables.md)
