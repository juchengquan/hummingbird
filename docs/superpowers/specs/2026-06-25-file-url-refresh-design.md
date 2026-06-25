# File-URL refresh on click — design

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — pending implementation plan

## Problem

Generated files (the code-interpreter feature, PR #265) persist their
bytes to Supabase Storage and surface a signed URL with a **1-year TTL**.
Once that URL expires, the download chip in the assistant message breaks
with no recovery — a slow-fuse correctness gap flagged in the #265 review
and deferred in that spec's non-goals.

Generated **images** already solve this: an expired URL trips
`<img onError>`, which lazily re-signs from the durable `storagePath` via
`POST /api/images/refresh-url`. Files have no equivalent. This feature
adds the same self-healing for file download chips.

## Goal

When a user clicks a file download chip whose signed URL may have expired,
transparently re-sign from the durable `storagePath` and download with the
fresh URL. Mirror the existing image-refresh path end to end.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Scope | **Chips only** — the download chips in the message. Match image parity. |
| Trigger | **Re-sign on click** — anchors have no `onError`, so intercept the click. |

### Why "chips only"

The file *chip* reads `Message.generatedFiles[]`, whose `storagePath`
field holds the durable, re-signable Supabase path. The file *artifact*
(Artifacts tab) stores only the signed URL in its `storagePath` field
(set as `storagePath: f.url` when the artifact is auto-created), so it
cannot re-sign — exactly the same limitation image artifacts have today.
Fixing the artifact path would require storing the real storage path on
the artifact (a data-model change), which is out of scope here.

### Why "re-sign on click"

`<a download href>` has no `onError`; an expired URL only fails when
clicked. Detecting expiry up front (parsing the signed URL's embedded
TTL, or a HEAD probe) is brittle or relies on uncertain Supabase
behavior. Downloads are user-initiated and infrequent, so always
re-signing on click (for cloud-mode files) is simplest and always
correct; the per-click sign round-trip is negligible.

## Components

All mirror the image path, swapping `image`→`file` /
`generatedImage`→`generatedFile`. Reference implementations:
`app/api/images/refresh-url/route.ts`,
`lib/server/image-storage.ts` (`signGeneratedImageUrl`),
`lib/client/api-client.ts` (`refreshGeneratedImageUrl` +
`apiUrls.imagesRefreshUrl`),
`lib/shared/api-schemas.ts` (`RefreshImageUrlRequest/ResponseSchema`),
`lib/client/hooks/store/slices/messages.ts`
(`updateMessageGeneratedImageUrl`),
`components/skills/generated-images-gallery.tsx` (the `<img onError>`
trigger).

### 1. Re-sign helper (`lib/server/file-storage.ts`)

Re-add `signGeneratedFileUrl(storagePath: string, client?: SupabaseClient<Database>): Promise<string | null>`
(deleted in the previous session as dead code; it now has a caller).
Identical to `signGeneratedImageUrl`:
`createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)` against the
`user-files` bucket; returns `null` if Supabase is unconfigured or the
sign call fails.

### 2. Route (`app/api/files/refresh-url/route.ts`)

`POST`, byte-for-byte the image route's behavior:

- 503 `unavailable` if Supabase isn't configured.
- 401 `auth` if not signed in.
- 400 `invalid_request` if the body fails `RefreshFileUrlRequestSchema`.
- **403 `forbidden` if `storagePath.split("/")[0] !== auth.uid()`** (the
  bucket layout is `<userId>/...`; fail fast before RLS surfaces an
  opaque error).
- 404 `not_found` if `signGeneratedFileUrl` returns null.
- `200 { url }` on success.

### 3. Schemas (`lib/shared/api-schemas.ts`)

```ts
export const RefreshFileUrlRequestSchema = z.object({
  storagePath: z.string().min(1).max(512)
    .refine((p) => !p.includes(".."), "storagePath must not contain ..")
    .refine((p) => !p.startsWith("/"), "storagePath must not start with /"),
})
export const RefreshFileUrlResponseSchema = z.object({ url: z.string().min(1) })
```
Plus the inferred `RefreshFileUrlRequestInput` / `RefreshFileUrlResponse`
type exports.

### 4. apiClient (`lib/client/api-client.ts`)

`refreshGeneratedFileUrl(storagePath, options?): Promise<string | null>`
via `dispatchedFetch`, with its own module-scoped in-flight dedupe map
(keyed like the image one). `apiUrls.filesRefreshUrl()` =
`url("/api/files/refresh-url")`; remote path `/v1/files/refresh-url`;
response validated by `RefreshFileUrlResponseSchema`. Exposed as
`apiClient.files.refreshUrl`.

**Remote backend:** the remote path is declared for contract parity, but
implementing `/v1/files/refresh-url` in `services/` (agent-ts / agent-py)
is **out of scope** — this feature targets the in-Next backend, like the
rest of the generated-files work.

### 5. Store mutation (`lib/client/hooks/store/slices/messages.ts`)

`updateMessageGeneratedFileUrl(messageId, fileId, url)` — find the
message, find the file in `generatedFiles[]` by id, replace its `url`;
no-op if the message/file is missing or the url is unchanged. Mirrors
`updateMessageGeneratedImageUrl`.

### 6. Chip trigger (`components/skills/generated-files-list.tsx`)

`GeneratedFilesList` gains a `messageId?: string` prop, threaded from
`components/panels/chat-message.tsx` (like `GeneratedImagesGallery`).

Each chip's `onClick`:

- **Cloud-mode file** (`file.storagePath` truthy **and** `messageId`
  present): `preventDefault`; guard against a concurrent in-flight click
  (a per-chip `useRef` boolean); `await apiClient.files.refreshUrl(file.storagePath)`;
  on a non-null result, call `updateMessageGeneratedFileUrl(messageId, file.id, fresh)`
  (so the href persists fresh across re-renders) and trigger the download
  programmatically (a transient `<a href={fresh} download={file.name}>` —
  create, click, remove); on null, best-effort download with the existing
  `file.url`.
- **Data-URL / local-mode file** (no `storagePath`): no interception; the
  native `<a download href={file.url}>` handles it.

## Data flow

```
click chip
  └─ storagePath? ──no──▶ native <a download> proceeds
        │yes
        ▼
   apiClient.files.refreshUrl(storagePath)  ──▶ POST /api/files/refresh-url
        │                                          └─ signGeneratedFileUrl → { url }
        ▼
   fresh url? ──no──▶ download with existing file.url (best-effort)
        │yes
        ▼
   updateMessageGeneratedFileUrl(messageId, file.id, fresh)   (store persists)
        │
        ▼
   programmatic download with fresh url
```

## Error handling

- Re-sign failure (Supabase down, object missing, 403/404) → `refreshUrl`
  returns `null` → best-effort download with the existing url. Never
  throws into the click handler.
- The in-flight `useRef` guard + the apiClient dedupe map prevent
  double-trigger on rapid clicks.
- Cross-origin Supabase signed URLs may have the browser ignore the
  `download` attribute (open in a tab instead) — this is the **existing**
  behavior of the current static chip anchor; not a regression.

## Testing

- **Route handler** — 503 (no Supabase), 401 (unauthenticated), 403
  (storagePath first segment ≠ uid), 404 (re-sign null), 200 `{ url }`.
  Mirror the image refresh-url route test if one exists; otherwise add a
  focused handler test under `app/api/` (a main test root).
- **Schemas** — `RefreshFileUrlRequestSchema` accepts a valid path and
  rejects `..` / leading `/`; response parses `{ url }`.
- **Store** — `updateMessageGeneratedFileUrl` replaces the right file's
  url and no-ops on a missing id (live store, like the messages-slice
  test added in the generated-files work).
- **Chip trigger** — not render-tested (the repo has no `@testing-library`
  / `.test.tsx` infra). If a unit seam helps, extract the "which url to
  download" decision as a pure helper and test that; otherwise verified
  by review + the manual check below.

## Manual verification

With Supabase configured + a generated file in a conversation: temporarily
shorten the signed-URL TTL (or hand-expire the URL), click the chip, and
confirm a fresh URL is fetched and the file downloads. Confirm a
data-URL (local-mode) file still downloads with no network call.

## Out of scope

- Artifacts-tab file download refresh (matches the existing image-artifact
  gap; would need the real `storagePath` stored on the artifact).
- Implementing `/v1/files/refresh-url` in the remote `services/` backends.
