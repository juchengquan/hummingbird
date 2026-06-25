# Artifacts-tab download URL refresh (file + image) — design

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — pending implementation plan

## Problem

A generated **artifact** (file or image) in the Artifacts tab stores a
Supabase **signed URL** in its `storagePath` field — not the durable
storage object path. Signed URLs carry a 1-year TTL, so the artifact's
download (`file`) or preview (`image`) eventually breaks with no way to
re-sign. This is the parallel gap to the chip refresh shipped in #267
(which fixed the in-message download chips but deliberately left the
artifact surface — "chips only").

Today, for both kinds, `use-chat-send.ts` creates the artifact with
`storagePath: <the signed url>` and `content: ""` (file) / the prompt
(image). The durable path exists on `Message.generatedFiles[].storagePath`
/ `Message.generatedImages[].storagePath` but is **not** copied to the
artifact.

## Goal

The Artifacts-tab download (file) and preview (image) self-heal an
expired signed URL by re-signing from the durable object path — reusing
the existing refresh endpoints. Because the path is derived from the
stored URL (see Approach), this also repairs artifacts generated *before*
this ships, not only new ones.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Scope | **Both `file` and `image` artifacts** |
| Where the re-signable path comes from | **Derive it from the stored signed URL** (no schema/migration) |

### Why derive-from-URL (not a new durable-path field)

A new `objectPath` column would be explicit, but: (a) it only fixes
artifacts created *after* it ships — everything already generated stays
broken; (b) it adds a migration + sync + `Database`-type wiring on a core
table. Deriving the path from the stored signed URL needs **no** schema
change, reuses the existing refresh routes, and fixes existing artifacts
too. The cost is a contained coupling to Supabase's signed-URL format,
isolated in one pure, unit-tested helper, with a graceful fallback
(unrecognized URL → behave exactly as today).

## Reuse (no new server surface)

This feature adds **no** route, schema, migration, or `Database`-type
change. It calls the existing endpoints:
`apiClient.files.refreshUrl(path)` (#267) and
`apiClient.images.refreshUrl(path)` (pre-existing). The parsed path
starts with `<uid>`, satisfying each route's 403 owner-check.

## Components

### 1. `parseStorageObjectPath` (pure helper, `lib/shared/`)

```ts
/** Extract the durable Supabase object path from a generated-asset
 *  signed URL, or null if the URL isn't a recognizable `user-files`
 *  signed URL (e.g. a data: URL or an unexpected shape). */
export function parseStorageObjectPath(url: string): string | null
```

- Recognizes the Supabase Storage signed-URL shape by the marker
  `/object/sign/user-files/`; returns everything after it up to `?`,
  URL-decoded — e.g.
  `https://<proj>.supabase.co/storage/v1/object/sign/user-files/<uid>/generated/<id>-report.csv?token=<jwt>`
  → `<uid>/generated/<id>-report.csv`.
- Returns `null` for `data:` URLs, URLs without the marker, or an empty
  path. Pure string logic, no I/O → lives in `lib/shared/` and is unit-tested.

Lives in a new `lib/shared/storage-url.ts` (single responsibility).

### 2. `updateArtifactStoragePath` store mutation (`artifacts` slice)

```ts
updateArtifactStoragePath: (artifactId: string, storagePath: string) => void
```

Replaces the artifact's `storagePath` with the fresh URL (no-op if the
id is missing or the value is unchanged), so the refreshed URL persists
across re-renders **and** syncs the new value to Supabase (the existing
`diffArtifacts` already writes `storage_path`, so a 1-year-fresh URL is
re-persisted — no sync change needed). Mirrors `updateArtifactContent`.

### 3. File artifact branch (`components/panels/artifacts-tab.tsx`)

The `file`-kind detail download `<a href={artifact.storagePath ?? artifact.content} download={artifact.title}>`
gains an `onClick`:

- `path = parseStorageObjectPath(href)`.
- `path` non-null → `preventDefault`; guard a concurrent in-flight click
  (a per-detail `useRef`); `await apiClient.files.refreshUrl(path)`; on a
  non-null result, `updateArtifactStoragePath(artifact.id, fresh)` and
  trigger the download programmatically (transient `<a download>`) with
  the fresh URL; on null, best-effort download with the existing `href`.
- `path` null (`data:` / unrecognized) → no interception; native
  `<a download>` handles it.

(Same shape as the chip's `FileChip` in `generated-files-list.tsx`, but
updates the **artifact** store entry rather than the message.)

### 4. Image artifact branch (`components/panels/artifacts-tab.tsx`)

The `image`-kind `<img src={artifact.storagePath ?? artifact.content}>`
gains an `onError` with a one-shot `useRef` guard (mirrors the
`<img onError>` in `generated-images-gallery.tsx`):

- On error: if already attempted, stop. Else mark attempted;
  `path = parseStorageObjectPath(src)`; if non-null →
  `await apiClient.images.refreshUrl(path)` → on success
  `updateArtifactStoragePath(artifact.id, fresh)` (the `<img>` re-renders
  with the fresh src). Null path or null refresh → leave the
  broken-image placeholder.

### Component structure

The detail view renders one selected artifact, so a single `useRef`
guard per surface is sufficient. If the existing detail render isn't
already a component with a hook scope, extract a small `ArtifactDownload`
(file) and wire the `onError` on the existing `<img>`; keep the change
localized to the two kind-branches.

## Error handling

- `parseStorageObjectPath` → null: no refresh attempted; download/preview
  behaves exactly as today (covers `data:`/local artifacts, which never
  expire).
- `refreshUrl` → null (Supabase down, object missing, 403/404): file →
  best-effort download with the existing URL; image → broken-image
  placeholder after the one-shot.
- Image one-shot `useRef` prevents an infinite re-sign loop on a path
  that refuses to re-sign.

## Testing

- **`parseStorageObjectPath`** — pure unit tests: a valid `user-files`
  signed URL → the expected path; a URL-encoded segment → decoded; a
  `data:` URL → null; a non-Supabase https URL → null; the marker present
  but empty path → null.
- **`updateArtifactStoragePath`** — live-store test (seed an artifact via
  `createArtifact`, update, assert `storagePath` replaced + no-op on
  unknown id), mirroring the `updateMessageGeneratedFileUrl` test.
- **Artifact branches** — not render-tested (no `@testing-library` in the
  repo). The pure helper + the store mutation carry the unit coverage;
  the wiring is verified by review + a new manual step appended to
  `docs/SMOKE-TEST-generated-files.md`.

## Out of scope

- No new field/column/migration/route (the whole point of the
  derive-from-URL approach).
- The in-message chips already refresh (#267); unchanged here.
