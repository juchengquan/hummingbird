# File-URL Refresh on Click — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a generated-file download chip transparently re-sign its expired Supabase URL on click, mirroring the existing generated-image refresh path.

**Architecture:** Six small pieces that mirror the image-refresh path (`image`→`file`): a `signGeneratedFileUrl` helper, a `POST /api/files/refresh-url` route, request/response Zod schemas, an `apiClient.files.refreshUrl` method, an `updateMessageGeneratedFileUrl` store mutation, and a click-intercept on the chip (anchors have no `onError`, so re-sign on click).

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Zustand, Zod, bun:test, Supabase Storage.

## Global Constraints

- Reference implementations to mirror (read the named symbol before writing its file's counterpart): `app/api/images/refresh-url/route.ts`; `signGeneratedImageUrl` in `lib/server/image-storage.ts`; `refreshGeneratedImageUrl` + `apiUrls.imagesRefreshUrl` in `lib/client/api-client.ts`; `RefreshImageUrlRequestSchema`/`RefreshImageUrlResponseSchema` in `lib/shared/api-schemas.ts`; its tests in `lib/shared/api-schemas.test.ts`; `updateMessageGeneratedImageUrl` in `lib/client/hooks/store/slices/messages.ts`; the `<img onError>` trigger in `components/skills/generated-images-gallery.tsx`.
- `lib/` runtime fences: `lib/server/*` → `import "server-only"`; `lib/client/*` → `import "client-only"`; `lib/shared/*` → none (pure). New files carry the right fence + alias imports (`@/server/*`, `@/client/*`, `@/shared/*`).
- Bucket layout is `<userId>/...`; the route MUST reject a `storagePath` whose first segment ≠ `auth.uid()` with **403**.
- Signed-URL TTL constant is `SIGNED_URL_TTL_SECONDS` (already in `lib/server/file-storage.ts`).
- Tests run via `bun test <path>`; new `*.test.ts` must sit under a configured root (`./lib`, `./components`, `./app/api/ai`, `./app/api/extract`, `./tests` — all paths here qualify).
- **No route unit test** for `app/api/files/refresh-url` — the image refresh route has none, and testing it needs `mock.module` on the Supabase server client (process-global leak in the shared run). Verify the route by `bun run check` + the manual check; the testable logic (schema, store mutation, gate helper) is unit-tested.
- Run `bun run check` before each commit; it must pass.
- Commit messages: **no `Co-Authored-By` trailer** (project convention).
- The frontend↔backend contract is pinned in `lib/shared/api-schemas.ts` + `docs/API.md`; the new endpoint follows the same dispatch pattern as the other `apiClient.*` methods.

---

## File Structure

- `lib/shared/api-schemas.ts` — add `RefreshFileUrlRequest/ResponseSchema` + type exports. (Task 1)
- `lib/shared/api-schemas.test.ts` — schema tests. (Task 1)
- `lib/server/file-storage.ts` — re-add `signGeneratedFileUrl`. (Task 2)
- `app/api/files/refresh-url/route.ts` *(new)* — the POST handler. (Task 2)
- `lib/client/api-client.ts` — `refreshGeneratedFileUrl` + `apiUrls.filesRefreshUrl` + `apiClient.files.refreshUrl`. (Task 3)
- `lib/client/hooks/store/slices/messages.ts` — `updateMessageGeneratedFileUrl`. (Task 4)
- `lib/client/hooks/store/slices/messages.test.ts` — mutation test (file exists from prior work). (Task 4)
- `components/skills/generated-files-list.tsx` — `messageId` prop, `shouldRefreshFile` helper, per-chip click-intercept. (Task 5)
- `components/skills/generated-files-list.test.ts` — `shouldRefreshFile` test (file exists). (Task 5)
- `components/panels/chat-message.tsx` — pass `messageId={message.id}`. (Task 5)

---

## Task 1: Refresh request/response schemas

**Files:**
- Modify: `lib/shared/api-schemas.ts`
- Test: `lib/shared/api-schemas.test.ts`

**Interfaces:**
- Produces: `RefreshFileUrlRequestSchema` (`{ storagePath: string }`, rejects empty / `..` / leading `/`), `RefreshFileUrlResponseSchema` (`{ url: string }`), and `RefreshFileUrlRequestInput` / `RefreshFileUrlResponse` types.

- [ ] **Step 1: Write the failing test**

In `lib/shared/api-schemas.test.ts`, add an import for the new schema (alongside the existing `RefreshImageUrlRequestSchema` import) and append:

```typescript
describe("RefreshFileUrlRequestSchema", () => {
  it("accepts a valid storage path", () => {
    const r = RefreshFileUrlRequestSchema.safeParse({
      storagePath: "user-123/generated/abc-report.csv",
    })
    expect(r.success).toBe(true)
  })
  it("rejects an empty path", () => {
    expect(RefreshFileUrlRequestSchema.safeParse({ storagePath: "" }).success).toBe(false)
  })
  it("rejects a path containing ..", () => {
    expect(
      RefreshFileUrlRequestSchema.safeParse({ storagePath: "user-123/../secret" }).success,
    ).toBe(false)
  })
  it("rejects a path starting with /", () => {
    expect(
      RefreshFileUrlRequestSchema.safeParse({ storagePath: "/abc/x.csv" }).success,
    ).toBe(false)
  })
  it("rejects a missing path", () => {
    expect(RefreshFileUrlRequestSchema.safeParse({}).success).toBe(false)
  })
})
```

Add `RefreshFileUrlRequestSchema` to the existing import block at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/shared/api-schemas.test.ts`
Expected: FAIL — `RefreshFileUrlRequestSchema` is not exported.

- [ ] **Step 3: Add the schemas**

In `lib/shared/api-schemas.ts`, immediately after the `RefreshImageUrlResponseSchema` block, add:

```typescript
// --- POST /api/files/refresh-url --------------------------------------------
//
// Re-sign an expired generated-FILE URL. The bytes live in Supabase
// Storage at `storagePath`; the route mints a fresh long-lived URL.
// Mirrors the image refresh-url contract.

export const RefreshFileUrlRequestSchema = z.object({
  storagePath: z
    .string()
    .min(1)
    .max(512)
    .refine((p) => !p.includes(".."), "storagePath must not contain ..")
    .refine((p) => !p.startsWith("/"), "storagePath must not start with /"),
})

export const RefreshFileUrlResponseSchema = z.object({
  url: z.string().min(1),
})
```

Then, next to the `RefreshImageUrl*` type exports, add:

```typescript
export type RefreshFileUrlRequestInput = z.infer<typeof RefreshFileUrlRequestSchema>
export type RefreshFileUrlResponse = z.infer<typeof RefreshFileUrlResponseSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/shared/api-schemas.test.ts`
Expected: PASS (existing + 5 new tests).

- [ ] **Step 5: Commit**

```bash
git add lib/shared/api-schemas.ts lib/shared/api-schemas.test.ts
git commit -m "feat(api): RefreshFileUrl request/response schemas"
```

---

## Task 2: `signGeneratedFileUrl` helper + the refresh-url route

**Files:**
- Modify: `lib/server/file-storage.ts`
- Create: `app/api/files/refresh-url/route.ts`

**Interfaces:**
- Consumes: `RefreshFileUrlRequestSchema` (Task 1).
- Produces: `signGeneratedFileUrl(storagePath: string, client?: SupabaseClient<Database>): Promise<string | null>`; `POST /api/files/refresh-url` returning `{ url }` on success.

> No unit test (see Global Constraints). Verify with `bun run check`. The
> helper and route mirror `signGeneratedImageUrl` + `app/api/images/refresh-url/route.ts`
> exactly — read both first.

- [ ] **Step 1: Re-add the helper**

In `lib/server/file-storage.ts`, append (the imports `SupabaseClient`, `Database`, `getSupabaseServerClient`, and the `SIGNED_URL_TTL_SECONDS` const are already present in this file):

```typescript
/**
 * Re-sign a generated file's storage path. Used by
 * `POST /api/files/refresh-url` when an old conversation hits an expired
 * signed URL — the bytes are still in the bucket at `storagePath`, we
 * just need a fresh signature. The caller does the auth check; this
 * helper only mints the URL. Returns null if Supabase isn't configured
 * or the sign call fails (e.g. the object was deleted out-of-band).
 */
export async function signGeneratedFileUrl(
  storagePath: string,
  client?: SupabaseClient<Database>,
): Promise<string | null> {
  const supabase = client ?? (await getSupabaseServerClient())
  if (!supabase) return null
  const { data, error } = await supabase.storage
    .from("user-files")
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}
```

If `SupabaseClient` / `Database` were removed when `signGeneratedFileUrl`
was deleted last session, re-add the imports:
`import type { SupabaseClient } from "@supabase/supabase-js"` and
`import type { Database } from "@/shared/supabase/types"` (check the top
of the file first; `getSupabaseServerClient` is imported from
`@/server/supabase/server`).

- [ ] **Step 2: Create the route**

Create `app/api/files/refresh-url/route.ts`:

```typescript
import "server-only"

/**
 * `POST /api/files/refresh-url` — re-sign an expired generated-file URL.
 *
 * Signed URLs minted by `persistGeneratedFiles` carry a 1-year TTL, so an
 * old conversation eventually hits an expired URL. The bytes are still in
 * Storage at `storagePath`; this route mints a fresh signature. Mirrors
 * `app/api/images/refresh-url/route.ts`.
 *
 * Authorisation: (1) caller must be signed in; (2) the supplied
 * `storagePath`'s first segment must match `auth.uid()` (bucket layout is
 * `<userId>/...`). RLS (migration 0003) also enforces this, but failing
 * fast with a clean 403 beats an opaque storage error.
 */

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { signGeneratedFileUrl } from "@/server/file-storage"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { RefreshFileUrlRequestSchema } from "@/shared/api-schemas"

export async function POST(req: NextRequest) {
  const client = await getSupabaseServerClient()
  if (!client) {
    return NextResponse.json(
      { code: "unavailable", message: "Supabase is not configured." },
      { status: 503 },
    )
  }
  const { data: userData, error: authError } = await client.auth.getUser()
  if (authError || !userData.user) {
    return NextResponse.json(
      { code: "auth", message: "Unauthorized." },
      { status: 401 },
    )
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json(
      { code: "invalid_request", message: "Body must be JSON." },
      { status: 400 },
    )
  }
  const parsed = RefreshFileUrlRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      { status: 400 },
    )
  }
  const { storagePath } = parsed.data

  const firstSegment = storagePath.split("/")[0]
  if (firstSegment !== userData.user.id) {
    return NextResponse.json(
      { code: "forbidden", message: "Storage path does not belong to you." },
      { status: 403 },
    )
  }

  const url = await signGeneratedFileUrl(storagePath, client)
  if (!url) {
    return NextResponse.json(
      {
        code: "not_found",
        message: "Could not re-sign the URL — object may be missing.",
      },
      { status: 404 },
    )
  }
  return NextResponse.json({ url })
}
```

- [ ] **Step 3: Verify**

Run: `bun run check`
Expected: PASS (typecheck + lint).

- [ ] **Step 4: Commit**

```bash
git add lib/server/file-storage.ts app/api/files/refresh-url/route.ts
git commit -m "feat(files): signGeneratedFileUrl + refresh-url route"
```

---

## Task 3: apiClient `files.refreshUrl`

**Files:**
- Modify: `lib/client/api-client.ts`

**Interfaces:**
- Consumes: `RefreshFileUrlResponseSchema` (Task 1), the route (Task 2).
- Produces: `apiClient.files.refreshUrl(storagePath: string, options?: DispatchOption): Promise<string | null>`; `apiUrls.filesRefreshUrl()`.

> No unit test — mirrors the untested `refreshGeneratedImageUrl`; verify
> with `bun run check`.

- [ ] **Step 1: Add the apiUrls entry**

In `lib/client/api-client.ts`, in the `apiUrls` object, immediately after
the `imagesRefreshUrl:` line, add:

```typescript
  filesRefreshUrl: () => url("/api/files/refresh-url"),
```

- [ ] **Step 2: Add the method**

Immediately after the `refreshGeneratedImageUrl` function (and its
`refreshUrlInflight` map), add a sibling — making sure
`RefreshFileUrlResponseSchema` is imported at the top of the file
alongside `RefreshImageUrlResponseSchema`:

```typescript
/** In-flight dedupe cache for `refreshGeneratedFileUrl`. Separate map
 *  from the image one so the two never collide on a shared key. */
const refreshFileUrlInflight = new Map<
  string,
  Promise<DispatchedFetchResult<{ url: string }>>
>()

async function refreshGeneratedFileUrl(
  storagePath: string,
  options?: DispatchOption,
): Promise<string | null> {
  const result = await dispatchedFetch<
    { storagePath: string },
    { storage_path: string },
    { url: string }
  >({
    path: "/v1/files/refresh-url",
    localUrl: apiUrls.filesRefreshUrl(),
    bodyForLocal: { storagePath },
    bodyForRemote: (b) => ({ storage_path: b.storagePath }),
    schema: RefreshFileUrlResponseSchema,
    dispatch: options,
    inflight: refreshFileUrlInflight,
    dedupeKey: await backendCacheKey(options, storagePath),
  })
  if (!result.ok) return null
  return result.data.url
}
```

- [ ] **Step 3: Expose on apiClient**

In the `apiClient` export object, immediately after the `images: { refreshUrl: refreshGeneratedImageUrl },` block, add:

```typescript
  files: {
    refreshUrl: refreshGeneratedFileUrl,
  },
```

- [ ] **Step 4: Verify**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/client/api-client.ts
git commit -m "feat(api-client): files.refreshUrl re-sign method"
```

---

## Task 4: `updateMessageGeneratedFileUrl` store mutation

**Files:**
- Modify: `lib/client/hooks/store/slices/messages.ts`
- Test: `lib/client/hooks/store/slices/messages.test.ts`

**Interfaces:**
- Produces: `updateMessageGeneratedFileUrl(messageId: string, fileId: string, url: string): void` on the messages slice.

- [ ] **Step 1: Write the failing test**

Append to `lib/client/hooks/store/slices/messages.test.ts`:

```typescript
describe("updateMessageGeneratedFileUrl", () => {
  test("replaces the url of the matching file", () => {
    const conv = useStore.getState().createConversation()
    const msg = useStore.getState().addMessage({ role: "assistant", content: "" }, conv.id)
    const file = {
      id: "f1", name: "a.csv", sizeBytes: 1, mimeType: "text/csv",
      url: "https://old", storagePath: "u/generated/f1-a.csv",
    }
    useStore.getState().appendMessageGeneratedFiles(msg.id, [file])
    useStore.getState().updateMessageGeneratedFileUrl(msg.id, "f1", "https://fresh")
    const got = useStore.getState().conversations
      .find((c) => c.id === conv.id)?.messages
      .find((m) => m.id === msg.id)?.generatedFiles?.[0]
    expect(got?.url).toBe("https://fresh")
    expect(got?.storagePath).toBe("u/generated/f1-a.csv")
  })

  test("no-ops on an unknown file id", () => {
    const conv = useStore.getState().createConversation()
    const msg = useStore.getState().addMessage({ role: "assistant", content: "" }, conv.id)
    const file = {
      id: "f1", name: "a.csv", sizeBytes: 1, mimeType: "text/csv",
      url: "https://old", storagePath: null,
    }
    useStore.getState().appendMessageGeneratedFiles(msg.id, [file])
    useStore.getState().updateMessageGeneratedFileUrl(msg.id, "nope", "https://fresh")
    const got = useStore.getState().conversations
      .find((c) => c.id === conv.id)?.messages
      .find((m) => m.id === msg.id)?.generatedFiles?.[0]
    expect(got?.url).toBe("https://old")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/client/hooks/store/slices/messages.test.ts`
Expected: FAIL — `updateMessageGeneratedFileUrl is not a function`.

- [ ] **Step 3: Implement**

In `lib/client/hooks/store/slices/messages.ts`, add to the slice interface
(next to `updateMessageGeneratedImageUrl`):

```typescript
  /** Replace the `url` on a single generated file. Used by the lazy
   *  signed-URL re-sign path (`apiClient.files.refreshUrl`) so the
   *  refreshed URL persists across re-renders. No-op if the message or
   *  file id doesn't exist. */
  updateMessageGeneratedFileUrl: (
    messageId: string,
    fileId: string,
    url: string,
  ) => void
```

And the implementation (next to `updateMessageGeneratedImageUrl`):

```typescript
  updateMessageGeneratedFileUrl: (messageId, fileId, url) =>
    set((state) =>
      updateMessage(state, messageId, (m) => {
        const files = m.generatedFiles
        if (!files) return m
        let changed = false
        const next = files.map((f) => {
          if (f.id !== fileId || f.url === url) return f
          changed = true
          return { ...f, url }
        })
        return changed ? { ...m, generatedFiles: next } : m
      }),
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/client/hooks/store/slices/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/client/hooks/store/slices/messages.ts lib/client/hooks/store/slices/messages.test.ts
git commit -m "feat(store): updateMessageGeneratedFileUrl mutation"
```

---

## Task 5: Chip click-intercept + `messageId` threading

**Files:**
- Modify: `components/skills/generated-files-list.tsx`
- Test: `components/skills/generated-files-list.test.ts`
- Modify: `components/panels/chat-message.tsx`

**Interfaces:**
- Consumes: `apiClient.files.refreshUrl` (Task 3), `updateMessageGeneratedFileUrl` (Task 4).
- Produces: `shouldRefreshFile(file: GeneratedFile, messageId: string | undefined): boolean`; `GeneratedFilesList({ files, messageId })`.

> The click handler itself isn't render-tested (no `@testing-library` in
> the repo). The gating logic is extracted as the pure `shouldRefreshFile`
> and unit-tested; the rest is verified by review + the manual check.

- [ ] **Step 1: Write the failing test**

Append to `components/skills/generated-files-list.test.ts`:

```typescript
import { shouldRefreshFile } from "./generated-files-list"

const f = (storagePath: string | null) => ({
  id: "x", name: "x", sizeBytes: 1, mimeType: "text/plain",
  url: "u", storagePath,
})

describe("shouldRefreshFile", () => {
  test("true for a cloud file with a messageId", () => {
    expect(shouldRefreshFile(f("u/generated/x"), "m1")).toBe(true)
  })
  test("false without a storagePath (data-URL / local file)", () => {
    expect(shouldRefreshFile(f(null), "m1")).toBe(false)
  })
  test("false without a messageId", () => {
    expect(shouldRefreshFile(f("u/generated/x"), undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test components/skills/generated-files-list.test.ts`
Expected: FAIL — `shouldRefreshFile` is not exported.

- [ ] **Step 3: Rewrite the component**

Replace the contents of `components/skills/generated-files-list.tsx` with
(keeps `humanSize` exported + unchanged; adds the gate helper, a
per-chip `FileChip` with the click-intercept, and the `messageId` prop):

```typescript
"use client"

import { useRef } from "react"
import { Download, FileText } from "lucide-react"

import { apiClient } from "@/client/api-client"
import { useStore } from "@/client/hooks/use-store"
import type { GeneratedFile } from "@/shared/types"

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

/** A chip can lazily re-sign its URL only when (1) the bytes are in
 *  Supabase Storage (has a `storagePath`) and (2) we know which message
 *  to update afterwards. Data-URL / local files download directly. */
export function shouldRefreshFile(
  file: GeneratedFile,
  messageId: string | undefined,
): boolean {
  return !!file.storagePath && !!messageId
}

/** Programmatic download via a transient anchor — used after an async
 *  re-sign, since the original click was prevented. */
function triggerDownload(url: string, name: string): void {
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function FileChip({
  file,
  messageId,
}: {
  file: GeneratedFile
  messageId?: string
}) {
  const updateFileUrl = useStore((s) => s.updateMessageGeneratedFileUrl)
  // Guard a rapid double-click while a re-sign is in flight. Resets after
  // each attempt so a later click re-signs again (URLs are short-lived).
  const inFlight = useRef(false)
  const canRefresh = shouldRefreshFile(file, messageId)

  const onClick = canRefresh
    ? async (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault()
        if (inFlight.current) return
        inFlight.current = true
        try {
          const fresh = await apiClient.files.refreshUrl(file.storagePath!)
          if (fresh) updateFileUrl(messageId!, file.id, fresh)
          triggerDownload(fresh ?? file.url, file.name)
        } finally {
          inFlight.current = false
        }
      }
    : undefined

  return (
    <a
      href={file.url}
      download={file.name}
      onClick={onClick}
      className="group flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)] px-2.5 py-1.5 text-xs hover:bg-[var(--accent)]"
    >
      <FileText className="size-4 shrink-0 text-[var(--muted-foreground)]" />
      <span className="max-w-[18ch] truncate font-medium">{file.name}</span>
      <span className="text-[var(--muted-foreground)]">{humanSize(file.sizeBytes)}</span>
      <Download className="size-3.5 shrink-0 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100" />
    </a>
  )
}

export function GeneratedFilesList({
  files,
  messageId,
}: {
  files: GeneratedFile[]
  messageId?: string
}) {
  if (files.length === 0) return null
  return (
    <div className="mt-2 mb-1 flex flex-wrap gap-2">
      {files.map((f) => (
        <FileChip key={f.id} file={f} messageId={messageId} />
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test components/skills/generated-files-list.test.ts`
Expected: PASS (existing `humanSize` tests + 3 new `shouldRefreshFile` tests).

- [ ] **Step 5: Thread `messageId` from the message**

In `components/panels/chat-message.tsx`, change the render call (the line
`<GeneratedFilesList files={message.generatedFiles} />`) to:

```tsx
<GeneratedFilesList files={message.generatedFiles} messageId={message.id} />
```

- [ ] **Step 6: Verify + commit**

Run: `bun run check`
Expected: PASS.

```bash
git add components/skills/generated-files-list.tsx components/skills/generated-files-list.test.ts components/panels/chat-message.tsx
git commit -m "feat(files): re-sign file download URL on chip click"
```

---

## Final verification (after all tasks)

- [ ] **Full gate**

```bash
bun run check && bun run test
```
Expected: typecheck + lint clean; all tests pass (the intentional
`postgres unreachable` throw at `route.handler.test.ts:240` is NOT a
failure).

- [ ] **Manual** (requires Supabase configured + a generated file in a
  conversation): hand-expire or shorten the signed-URL TTL, click the
  chip, confirm a fresh URL is fetched (network tab shows
  `POST /api/files/refresh-url`) and the file downloads. Confirm a
  data-URL (local-mode) file still downloads with no network call.

---

## Self-Review

**Spec coverage:**
- Re-sign helper → Task 2. ✓
- Route (503/401/400/403/404/200) → Task 2. ✓
- Schemas → Task 1. ✓
- apiClient `files.refreshUrl` + remote path declared → Task 3. ✓
- Store mutation → Task 4. ✓
- Chip click-intercept + `messageId` threading + data-URL passthrough → Task 5. ✓
- Out of scope (artifact refresh, remote `services/` impl) → not tasked, correct. ✓

**Type consistency:** `signGeneratedFileUrl(storagePath, client?)` (Task 2) is the symbol the route imports (Task 2) — same task. `RefreshFileUrlRequestSchema` (Task 1) is consumed by the route (Task 2); `RefreshFileUrlResponseSchema` (Task 1) by the apiClient method (Task 3). `apiClient.files.refreshUrl` (Task 3) + `updateMessageGeneratedFileUrl(messageId, fileId, url)` (Task 4) are both consumed by `FileChip` (Task 5) with matching signatures. `GeneratedFilesList({ files, messageId })` (Task 5) matches the `chat-message.tsx` call site (Task 5). `shouldRefreshFile(file, messageId)` is defined and tested in Task 5.

**Placeholder scan:** none — every code step carries full code.
