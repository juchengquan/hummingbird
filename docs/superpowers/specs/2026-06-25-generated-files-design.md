# Generated files from the code interpreter — design

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — pending implementation plan

## Problem

The `runCode` skill executes model-written Python in an airgapped
microsandbox. Today the only outputs that survive the sandbox are:

- **Images** — `savefig('/tmp/*.png')` PNGs, read back, persisted to
  `Message.generatedImages` (JSONB) **and** auto-created as an `image`
  artifact.
- **Text results** — stdout/stderr/table cells, surfaced via
  `Message.codeResults` but **ephemeral** (no DB column; lost on reload).

If the model writes any other file — `report.xlsx`, `data.csv`,
`output.zip`, a generated PDF — it is **silently dropped**. There is no
capture path, no UI surface, and the artifact model has no binary/file
kind (only `image` uses `storagePath`).

## Goal

Capture arbitrary files the code interpreter produces, surface them
inline in the chat message as download chips, and persist them as
workspace-scoped artifacts so the user can find and download them later
from the **Artifacts** tab.

Non-goals (deliberately deferred):

- Generated files from sources other than the code interpreter (e.g. a
  general "export this artifact/message to a file" action).
- Storing/reorganizing existing artifacts or uploaded files.
- A size/count cap on captured files (see Caps below).
- **File-URL refresh on expiry.** Unlike generated images (which self-heal
  via `/api/images/refresh-url`), generated files have no re-sign path yet.
  In Supabase/cloud mode a download URL is valid for its 1-year signed-URL
  TTL, then breaks until refresh is wired; local/data-URL mode is unaffected.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Source to surface | Code-interpreter file outputs only |
| Where the user finds them | **Artifacts** tab, via a new `file` artifact kind (Files tab stays uploads-only) |
| Which files get captured | Everything in a **designated output dir** (`/tmp/outputs/`) |
| Inline chat UX | **Download chips** in the assistant message (like the generated-images gallery) |
| Caps | **None for now** — bounded in practice by the microVM's disk/memory (`CODE_SANDBOX_MEM_MIB`) |
| Data model | **Approach A — mirror the generated-images pipeline** |

Approach A reuses the entire generated-images path end to end (storage
upload + data-URL fallback, SSE frame, store-append mutation, gallery
render, auto-artifact). The feature is essentially "the image pipeline,
for arbitrary bytes," which makes it the lowest-risk option and gives
file metadata (size, mime) a natural home without bending the
`artifacts` schema.

## Data model

New type in `lib/shared/types.ts`, mirroring `GeneratedImage`:

```ts
export interface GeneratedFile {
  id: string
  name: string                 // original filename from the output dir
  sizeBytes: number
  mimeType: string
  url: string                  // Supabase signed URL, or data: fallback
  storagePath: string | null   // for re-signing
}
```

- `Message.generatedFiles?: GeneratedFile[]` — new field, persisted with
  the **same** partialize/migration treatment that `generatedImages`
  already receives.
- `ArtifactKind` gains `'file'`:
  `'code' | 'markdown' | 'json' | 'table' | 'image' | 'file' | 'other'`.
- A `file` artifact carries `title = name` and the blob via
  `storagePath` (exactly like `image`); `content` stays empty for this
  kind.

### Migrations

One new file `supabase/migrations/0018_message_generated_files.sql`
(next number after the current `0017_*`), containing two changes:

1. `alter table messages add column generated_files jsonb` — mirror
   `0010_message_generated_images.sql`.
2. Drop and recreate the `artifacts.kind` check constraint to add
   `'file'` to the allowed set.

The new `'file'` kind is a new enum **value**, not a new persisted
**key**, so the frozen persisted key-set / `STORE_VERSION` contract in
`store/persist.test.ts` is unchanged. `generatedFiles` follows whatever
treatment `generatedImages` already has in `partializeState` /
`runMigrations`.

## Capture (sandbox + skill prompt)

- **Skill prompt** (`lib/server/skills/code-interpreter.ts`): instruct
  the model to write any deliverable files to `/tmp/outputs/`. Files
  written elsewhere are not captured (predictable, no noise from
  intermediate temp files).
- **Sandbox adapter** (`lib/server/code-sandbox/`): after the run, read
  every file in `/tmp/outputs/` back — the same read-back mechanism that
  already pulls `savefig` PNGs, pointed at a directory. Extend
  `CodeRunResult` with `files: CodeFile[]` (`{ name, bytes, mime }`).
- **No cap** — capture whatever is in the output dir. Bounded in
  practice by the microVM's own disk and `CODE_SANDBOX_MEM_MIB`. This is
  a deliberate deferral; revisit if a per-file/count cap proves needed
  (the env-var pattern `CODE_SANDBOX_FILE_*` mirroring `_STDOUT_CAP` /
  `_RESULT_CAP` is the natural place).

## Server persistence + SSE

In `app/api/chat/route.ts`, alongside the existing image persistence
(~lines 220–272):

1. Upload each captured file to Supabase storage at
   `{user_id}/generated/{toolCallId}-{name}` (data-URL fallback when
   storage is absent — same as images).
2. Build a `GeneratedFile`, emit a new `data-tool-file` SSE frame, and
   append it to `Message.generatedFiles`.
3. Auto-create a `file` artifact (`title = name`, `storagePath`),
   mirroring the image auto-artifact (~line 670).

The new frame is documented in `docs/API.md` and handled in the
`emitter` and `lib/client/chat/sse-frame-translator.ts`.

## Client + rendering

- `lib/client/hooks/use-chat-send.ts`: `appendMessageGeneratedFiles`
  + auto-create the file artifact (mirror the image handling).
- Store: `appendMessageGeneratedFiles` mutation in the `messages` slice.
- **New component** `components/skills/generated-files-list.tsx`: a row
  of download chips (icon, filename, human-readable size), rendered in
  `components/panels/chat-message.tsx` beside the image gallery.
- **Artifacts tab** (`components/panels/artifacts-tab.tsx`): a
  `file`-kind branch rendering a download row (re-sign from
  `storagePath`) instead of an inline preview.

## Error handling & local-only

- Any per-file failure (unreadable, upload error) → skip that file,
  continue, never fatal (mirrors `persistGeneratedImages`).
- No Supabase configured → `data:` URL fallback, like images. With no
  cap, a large file yields a large data URL; accepted per the scope
  decision, bounded by sandbox disk/memory.
- Empty or missing `/tmp/outputs/` → no-op.

## Testing

- **Sandbox adapter** — captures files from the output dir (unit, mocked
  sandbox).
- **Route handler** — persists files + emits the `data-tool-file` frame
  (mirror the existing image-persistence tests).
- **Store** — `appendMessageGeneratedFiles` + auto-artifact creation.
- **Artifacts tab** — `file`-kind renders a download row.
- **Migration** — round-trip on `generated_files` + the recreated
  `kind` constraint.

## Suggested PR slices

1. **Backend** — types + migration + sandbox capture + server
   persistence + SSE frame + auto-artifact. Files are captured,
   persisted, and visible in the Artifacts tab.
2. **Inline UX** — `generated-files-list.tsx` download chips in the
   assistant message.
3. **Polish** — Artifacts-tab `file`-kind download affordance + final
   skill-prompt wording.
