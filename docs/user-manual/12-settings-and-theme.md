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
  reloads.
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
