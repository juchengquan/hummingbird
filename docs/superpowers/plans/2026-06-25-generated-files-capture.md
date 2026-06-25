# Generated Files from the Code Interpreter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture arbitrary files the `runCode` sandbox writes to `/tmp/outputs/`, surface them as download chips inline in the chat message, and persist them as workspace-scoped `file` artifacts findable in the Artifacts tab.

**Architecture:** Mirror the existing generated-**images** pipeline end-to-end for arbitrary bytes. The sandbox reads back files from a designated output dir → a new `lib/server/file-storage.ts` uploads them to Supabase Storage (data-URL fallback) → a new `data-tool-file` SSE frame carries them to the client → the client appends them to `Message.generatedFiles` and auto-creates a `file` artifact → a new chips component and an Artifacts-tab `file` branch render them. A new `messages.generated_files` JSONB column + the sync diff give cross-device parity.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Zustand, Zod, bun:test, Supabase (Postgres + Storage), microsandbox.

## Global Constraints

- Tests run via `bun run test` (wraps `scripts/run-tests.sh`); a single file runs with `bun test <path>`. Roots are `./app/api/ai ./app/api/extract ./components ./lib ./scripts ./tests` plus the isolated `./app/api/tasks`. Every new `*.test.ts` MUST sit under one of those roots (all paths in this plan do).
- `lib/` runtime fences: `lib/server/*` files start with `import "server-only"` and may import `@/server/*` + `@/shared/*`; `lib/client/*` start with `import "client-only"`; `lib/shared/*` are pure, no I/O. New files MUST carry the correct fence + alias imports.
- Frontend ↔ backend wire shapes are pinned in `lib/shared/api-schemas.ts` + documented in `docs/API.md`. The new SSE frame MUST be documented in `docs/API.md`.
- **No new size/count cap** for generated files (deliberate scope decision): reuse the existing `RESULT_FILE_MAX` (20) + `RESULT_CAP` (10 MB) read-back budget that already bounds sandbox memory. Do NOT add `CODE_SANDBOX_FILE_*` env vars.
- Run `bun run check` (typecheck + lint) before every commit; it must pass.
- Commit messages: NO `Co-Authored-By` trailer (project convention).
- The persisted localStorage key-set + `STORE_VERSION` are a frozen contract (`store/persist.test.ts`). The `'file'` ArtifactKind is a new enum *value* (not a new persisted *key*) and `generatedFiles` rides inside the already-persisted `conversations` key, so NO `STORE_VERSION` bump is required.

---

## File Structure

**Slice 1 — Backend capture, persist, emit, sync (Tasks 1–9)**
- `lib/server/code-sandbox/types.ts` — add `CodeFile` type + `CodeRunResult.files`.
- `lib/server/code-sandbox/mime.ts` *(new)* — pure extension→MIME map.
- `lib/server/code-sandbox/marshal.ts` — pass `RawRun.files` → `CodeRunResult.files`.
- `lib/server/code-sandbox/microsandbox-client.ts` — read back `/tmp/outputs/`.
- `lib/shared/types.ts` — `GeneratedFile` type, `Message.generatedFiles`, `ArtifactKind` += `'file'`.
- `lib/server/file-storage.ts` *(new)* — `persistGeneratedFiles` + `signGeneratedFileUrl`.
- `lib/server/chat/sse-emitter.ts` — `ToolFilePayload` + `toolFile()`.
- `app/api/chat/route.ts` — extend `maybeEmitCodeResultFrames` to persist + emit files.
- `supabase/migrations/0018_message_generated_files.sql` *(new)* — column + `kind` constraint.
- `lib/client/sync/reconcile.ts` + `lib/client/sync/handlers.ts` — parse/select/diff `generated_files`.

**Slice 2 — Client wiring + inline UX (Tasks 10–14)**
- `lib/client/chat/sse-frame-translator.ts` — `data-tool-file` → `tool_file`.
- `lib/client/hooks/store/slices/messages.ts` — `appendMessageGeneratedFiles`.
- `lib/client/hooks/use-chat-send.ts` — handle `tool_file`, auto-create `file` artifact.
- `components/skills/generated-files-list.tsx` *(new)* — download chips.
- `components/panels/chat-message.tsx` — render the chips.
- `components/panels/artifacts-tab.tsx` — `file`-kind download branch.

**Slice 3 — Skill prompt (Task 15)**
- `lib/server/skills/code-interpreter.ts` — instruct the model to write to `/tmp/outputs/`.

---

## Slice 1 — Backend

### Task 1: `CodeFile` type + `CodeRunResult.files`

**Files:**
- Modify: `lib/server/code-sandbox/types.ts`

**Interfaces:**
- Produces: `CodeFile = { name: string; mimeType: string; sizeBytes: number; data: string }` (`data` is base64); `CodeRunResult.files?: CodeFile[]`.

- [ ] **Step 1: Add the types**

In `lib/server/code-sandbox/types.ts`, after the `CodeResult` union (line 10) and inside `CodeRunResult` (after `results: CodeResult[]`, line 16):

```typescript
/** A whole file the run wrote to the designated output dir
 *  (`/tmp/outputs/`). Distinct from `CodeResult` cells, which render
 *  inline in the code-output block; files are downloadable artifacts. */
export interface CodeFile {
  name: string
  mimeType: string
  sizeBytes: number
  /** Base64 of the file bytes. */
  data: string
}
```

Then add to `CodeRunResult` (immediately after `results: CodeResult[]`):

```typescript
  /** Files the run wrote to `/tmp/outputs/`. Surfaced as download
   *  chips + `file` artifacts, separate from the inline `results`. */
  files?: CodeFile[]
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS (no consumers yet; additive change).

- [ ] **Step 3: Commit**

```bash
git add lib/server/code-sandbox/types.ts
git commit -m "feat(sandbox): add CodeFile type + CodeRunResult.files"
```

---

### Task 2: Pure extension→MIME helper

**Files:**
- Create: `lib/server/code-sandbox/mime.ts`
- Test: `lib/server/code-sandbox/mime.test.ts`

**Interfaces:**
- Produces: `mimeForName(name: string): string` — maps a filename's extension to a MIME type, default `application/octet-stream`.

- [ ] **Step 1: Write the failing test**

Create `lib/server/code-sandbox/mime.test.ts`:

```typescript
import { describe, expect, it } from "bun:test"

import { mimeForName } from "./mime"

describe("mimeForName", () => {
  it("maps common deliverable extensions", () => {
    expect(mimeForName("report.csv")).toBe("text/csv")
    expect(mimeForName("data.json")).toBe("application/json")
    expect(mimeForName("out.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    expect(mimeForName("doc.pdf")).toBe("application/pdf")
    expect(mimeForName("archive.zip")).toBe("application/zip")
    expect(mimeForName("notes.txt")).toBe("text/plain")
  })

  it("is case-insensitive on the extension", () => {
    expect(mimeForName("REPORT.CSV")).toBe("text/csv")
  })

  it("falls back to octet-stream for unknown / missing extensions", () => {
    expect(mimeForName("mystery.bin")).toBe("application/octet-stream")
    expect(mimeForName("noext")).toBe("application/octet-stream")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/server/code-sandbox/mime.test.ts`
Expected: FAIL — cannot find module `./mime`.

- [ ] **Step 3: Write the implementation**

Create `lib/server/code-sandbox/mime.ts`:

```typescript
import "server-only"

/** Minimal extension→MIME map for files the code interpreter writes to
 *  the output dir. The sandbox is airgapped, so we infer from the name
 *  rather than sniff bytes. Unknown extensions → octet-stream (the
 *  browser still downloads it; only the chip icon is generic). */
const MIME_BY_EXT: Record<string, string> = {
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  pdf: "application/pdf",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  parquet: "application/vnd.apache.parquet",
}

export function mimeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase()
  if (!ext || ext === name.toLowerCase()) return "application/octet-stream"
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/server/code-sandbox/mime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/server/code-sandbox/mime.ts lib/server/code-sandbox/mime.test.ts
git commit -m "feat(sandbox): add mimeForName extension map"
```

---

### Task 3: Marshaller passes files through

**Files:**
- Modify: `lib/server/code-sandbox/marshal.ts`
- Test: `lib/server/code-sandbox/marshal.test.ts`

**Interfaces:**
- Consumes: `CodeFile` (Task 1).
- Produces: `RawRun.files?: { name: string; mime: string; data: string }[]`; `toCodeRunResult` now sets `result.files` (computing `sizeBytes` from the base64 length).

- [ ] **Step 1: Write the failing test**

Append to `lib/server/code-sandbox/marshal.test.ts`:

```typescript
import { describe, expect, it } from "bun:test"

import { toCodeRunResult } from "./marshal"

describe("toCodeRunResult — files", () => {
  it("passes output files through with computed sizeBytes", () => {
    const data = Buffer.from("col1,col2\n1,2\n").toString("base64")
    const out = toCodeRunResult({
      stdout: "",
      stderr: "",
      exitCode: 0,
      images: [],
      timedOut: false,
      files: [{ name: "report.csv", mime: "text/csv", data }],
    })
    expect(out.files).toEqual([
      {
        name: "report.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.from(data, "base64").length,
        data,
      },
    ])
  })

  it("defaults files to an empty array when none were written", () => {
    const out = toCodeRunResult({
      stdout: "hi",
      stderr: "",
      exitCode: 0,
      images: [],
      timedOut: false,
    })
    expect(out.files).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/server/code-sandbox/marshal.test.ts`
Expected: FAIL — `out.files` is `undefined` (not yet mapped).

- [ ] **Step 3: Implement**

In `lib/server/code-sandbox/marshal.ts`, add to the `RawRun` interface (after the `tables?: unknown[]` field, line 17):

```typescript
  /** Whole files the run wrote to the output dir. Passed through to
   *  `CodeRunResult.files` with `sizeBytes` computed here. */
  files?: { name: string; mime: string; data: string }[]
```

Update the import on line 4 to include `CodeFile`:

```typescript
import type { CodeFile, CodeResult, CodeRunResult } from "./types"
```

In `toCodeRunResult`, just before the first `return` (the `upstreamError` check, line 137), compute the files array:

```typescript
  const files: CodeFile[] = (raw.files ?? []).map((f) => ({
    name: f.name,
    mimeType: f.mime,
    sizeBytes: Buffer.from(f.data, "base64").length,
    data: f.data,
  }))
```

Then add `files` to all four return objects. Each currently looks like
`return { ok: false, stdout, stderr, results, error: { ... } }` (and the
final `return { ok: true, stdout, stderr, results }`); add `, files` to
each, e.g.:

```typescript
  if (raw.upstreamError !== undefined) {
    return { ok: false, stdout, stderr, results, files, error: { code: "upstream", message: raw.upstreamError } }
  }
  if (raw.timedOut) {
    return { ok: false, stdout, stderr, results, files, error: { code: "timeout", message: "Execution exceeded the time limit." } }
  }
  if (raw.exitCode !== 0) {
    return { ok: false, stdout, stderr, results, files, error: { code: "runtime", message: stderr || `Exited with code ${raw.exitCode}.` } }
  }
  return { ok: true, stdout, stderr, results, files }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/server/code-sandbox/marshal.test.ts`
Expected: PASS (existing tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/server/code-sandbox/marshal.ts lib/server/code-sandbox/marshal.test.ts
git commit -m "feat(sandbox): marshal output files into CodeRunResult.files"
```

---

### Task 4: Read back `/tmp/outputs/` in the microsandbox client

**Files:**
- Modify: `lib/server/code-sandbox/microsandbox-client.ts`

**Interfaces:**
- Consumes: `mimeForName` (Task 2), `RawRun.files` (Task 3).

> **Note on testing:** `microsandbox-client.ts` boots a real microVM and has no unit test today (consistent with the rest of the file — the image/table read-back is also untested here). The pure logic it relies on (`mimeForName`, the marshaller mapping) IS unit-tested in Tasks 2–3. This task is verified by typecheck + the manual sandbox check in the Slice-1 verification step. Do NOT invent a fake `Sandbox` harness — follow the existing untested-integration pattern.

- [ ] **Step 1: Add the output-dir constant + mime import**

In `lib/server/code-sandbox/microsandbox-client.ts`, add to the imports (after line 16, `import { runtimeFor } from "./runtime"`):

```typescript
import { mimeForName } from "./mime"
```

After the `TABLE_RE` constant (line 28), add:

```typescript
/** Files the model writes here are captured whole as `file` artifacts.
 *  Separate from the /tmp chart/table read-back so intermediate temp
 *  files in /tmp aren't swept up. */
const OUTPUT_DIR = "/tmp/outputs"
```

- [ ] **Step 2: Read the output dir after the chart/table read-back**

Immediately after the existing chart/table `try { ... } catch { ... }`
block ends (line 183) and before `return toCodeRunResult({ ... })`
(line 185), insert:

```typescript
        // Read back whole files the run wrote to the designated output
        // dir. Reuses the same count + byte budget that bounds the chart
        // read-back, so this adds no new cap (deliberate). A missing
        // /tmp/outputs is the normal case — the model only writes there
        // when it produces a deliverable file.
        const files: RawRun["files"] = []
        try {
          const entries = await sb.fs().list(OUTPUT_DIR)
          let readBytes = 0
          let filesRead = 0
          for (const entry of entries) {
            if (filesRead >= RESULT_FILE_MAX) break
            if (entry.kind !== "file") continue
            const path = entry.path.startsWith("/")
              ? entry.path
              : `${OUTPUT_DIR}/${entry.path}`
            if (readBytes + entry.size > RESULT_CAP) continue
            const bytes = await sb.fs().read(path)
            readBytes += bytes.length
            filesRead++
            const name = path.split("/").pop() ?? path
            files.push({
              name,
              mime: mimeForName(name),
              data: Buffer.from(bytes).toString("base64"),
            })
          }
        } catch {
          // No output dir is the common case; not an error.
        }
```

- [ ] **Step 3: Thread `files` into the result**

Change the success return (line 185) from:

```typescript
        return toCodeRunResult({ stdout, stderr, exitCode, images, timedOut, tables })
```

to:

```typescript
        return toCodeRunResult({ stdout, stderr, exitCode, images, timedOut, tables, files })
```

- [ ] **Step 4: Verify typecheck + lint**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/code-sandbox/microsandbox-client.ts
git commit -m "feat(sandbox): capture /tmp/outputs files from the microVM"
```

---

### Task 5: `GeneratedFile` type + `Message.generatedFiles` + `'file'` ArtifactKind

**Files:**
- Modify: `lib/shared/types.ts`

**Interfaces:**
- Produces: `GeneratedFile = { id: string; name: string; sizeBytes: number; mimeType: string; url: string; storagePath: string | null }`; `Message.generatedFiles?: GeneratedFile[]`; `ArtifactKind` includes `'file'`.

- [ ] **Step 1: Add the `GeneratedFile` type**

In `lib/shared/types.ts`, immediately after the `GeneratedImage` interface (ends line 575), add:

```typescript
/** A file the code interpreter wrote to `/tmp/outputs/`, persisted and
 *  surfaced as a download chip + `file` artifact. Mirrors the persistence
 *  posture of `GeneratedImage`: `url` is a Supabase signed URL or a `data:`
 *  fallback; `storagePath` is set only when the bytes went to Storage so
 *  the client can re-sign on expiry. */
export interface GeneratedFile {
  id: string
  name: string
  sizeBytes: number
  mimeType: string
  url: string
  storagePath: string | null
}
```

- [ ] **Step 2: Add the `Message` field**

In the `Message` interface, immediately after `generatedImages?: GeneratedImage[]` (line 488):

```typescript
  /** Files the `runCode` interpreter produced. Surfaced as download
   *  chips; each also becomes a workspace `file` artifact. */
  generatedFiles?: GeneratedFile[]
```

- [ ] **Step 3: Extend `ArtifactKind`**

Change line 725 from:

```typescript
export type ArtifactKind = 'code' | 'markdown' | 'json' | 'table' | 'image' | 'other'
```

to:

```typescript
export type ArtifactKind = 'code' | 'markdown' | 'json' | 'table' | 'image' | 'file' | 'other'
```

- [ ] **Step 4: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS (additive; the `kind` switch in artifacts-tab has a fallthrough default, so no exhaustiveness break — confirmed in Task 14).

- [ ] **Step 5: Commit**

```bash
git add lib/shared/types.ts
git commit -m "feat(types): GeneratedFile + Message.generatedFiles + file ArtifactKind"
```

---

### Task 6: `lib/server/file-storage.ts` — persist generated files

**Files:**
- Create: `lib/server/file-storage.ts`
- Test: `lib/server/file-storage.test.ts`

**Interfaces:**
- Produces:
  - `FileToPersist = { id: string; name: string; mimeType: string; sizeBytes: number; bytes: Buffer }`
  - `PersistedFile = { id: string; name: string; mimeType: string; sizeBytes: number; url: string; storagePath: string | null }`
  - `persistGeneratedFiles(inputs: FileToPersist[], opts?: { signal?: AbortSignal; localFilesOnly?: boolean }): Promise<{ ok: true; files: PersistedFile[] } | { ok: false; error: string }>`
  - `signGeneratedFileUrl(storagePath: string, client?): Promise<string | null>`

> The bytes arrive already in hand (base64 from the sandbox), so unlike
> `image-storage.ts` there is **no download step** — we upload directly or
> fall back to a data URL. This mirrors `persistOne`'s cloud/data-URL
> branch without `downloadBytes`.

- [ ] **Step 1: Write the failing test**

Create `lib/server/file-storage.test.ts`:

```typescript
import { describe, expect, it, mock } from "bun:test"

// No Supabase configured → data-URL fallback path (getSupabaseServerClient
// returns null). This is the anonymous/local posture and needs no mocking
// beyond the module returning null.
mock.module("@/server/supabase/server", () => ({
  getSupabaseServerClient: async () => null,
}))

import { persistGeneratedFiles } from "./file-storage"

describe("persistGeneratedFiles — data-URL fallback", () => {
  it("returns a data: URL with the file's mime when Supabase is absent", async () => {
    const bytes = Buffer.from("col1,col2\n1,2\n")
    const res = await persistGeneratedFiles([
      {
        id: "call-0",
        name: "report.csv",
        mimeType: "text/csv",
        sizeBytes: bytes.length,
        bytes,
      },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files).toHaveLength(1)
    const f = res.files[0]
    expect(f.url).toBe(`data:text/csv;base64,${bytes.toString("base64")}`)
    expect(f.storagePath).toBeNull()
    expect(f.name).toBe("report.csv")
    expect(f.sizeBytes).toBe(bytes.length)
  })

  it("returns ok with an empty list for no inputs", async () => {
    const res = await persistGeneratedFiles([])
    expect(res).toEqual({ ok: true, files: [] })
  })

  it("forces the data-URL path when localFilesOnly is set", async () => {
    const bytes = Buffer.from("x")
    const res = await persistGeneratedFiles(
      [{ id: "a", name: "a.bin", mimeType: "application/octet-stream", sizeBytes: 1, bytes }],
      { localFilesOnly: true },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files[0].storagePath).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/server/file-storage.test.ts`
Expected: FAIL — cannot find module `./file-storage`.

- [ ] **Step 3: Implement**

Create `lib/server/file-storage.ts`:

```typescript
import "server-only"

/**
 * Persistence layer for files the `runCode` code interpreter writes to
 * `/tmp/outputs/`. Mirrors `image-storage.ts`, but the bytes arrive in
 * hand (base64 read back from the sandbox) so there is no download step.
 *
 *   1. **Supabase Storage** — when a session is present, upload to
 *      `user-files/{user_id}/generated/{id}-{name}` and mint a 1-year
 *      signed URL; `storagePath` travels back so the client can re-sign.
 *   2. **Data URL fallback** — anonymous / unconfigured Supabase, or any
 *      upload failure. Returns `data:{mime};base64,{...}`.
 *
 * No size cap here (deliberate): the upstream sandbox read-back already
 * bounds bytes via RESULT_FILE_MAX + RESULT_CAP.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { getSupabaseServerClient } from "@/server/supabase/server"
import type { Database } from "@/shared/supabase/types"

/** 1-year signed URLs — matches image-storage + the file-upload flow. */
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365

export interface FileToPersist {
  /** Stable id used as the storage object-name prefix + the React key. */
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  bytes: Buffer
}

export interface PersistedFile {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  /** Supabase signed URL or a `data:` URL — the UI loads either in a link. */
  url: string
  /** Set only when persistence went to Storage; used to re-sign on expiry. */
  storagePath: string | null
}

export interface PersistFilesOpts {
  signal?: AbortSignal
  /** Mirror of the client's "Store files locally" preference. */
  localFilesOnly?: boolean
}

export type PersistFilesResult =
  | { ok: true; files: PersistedFile[] }
  | { ok: false; error: string }

interface CloudContext {
  client: SupabaseClient<Database>
  userId: string
}

async function resolveCloudContext(): Promise<CloudContext | null> {
  const client = await getSupabaseServerClient()
  if (!client) return null
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return null
  return { client, userId: data.user.id }
}

/** Strip path separators from a model-chosen filename so it can't escape
 *  the user's storage folder. */
function safeName(name: string): string {
  const base = name.split("/").pop()?.split("\\").pop() ?? name
  return base.replace(/[^A-Za-z0-9._-]/g, "_") || "file"
}

async function uploadToBucket(
  input: FileToPersist,
  cloud: CloudContext,
): Promise<{ path: string; signedUrl: string } | null> {
  const path = `${cloud.userId}/generated/${input.id}-${safeName(input.name)}`
  const { error: uploadError } = await cloud.client.storage
    .from("user-files")
    .upload(path, input.bytes, {
      contentType: input.mimeType,
      upsert: true,
    })
  if (uploadError) return null
  const { data, error: signError } = await cloud.client.storage
    .from("user-files")
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
  if (signError || !data?.signedUrl) return null
  return { path, signedUrl: data.signedUrl }
}

function persistOne(
  input: FileToPersist,
  cloud: CloudContext | null,
): Promise<PersistedFile> {
  const dataUrl = (): PersistedFile => ({
    id: input.id,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    url: `data:${input.mimeType};base64,${input.bytes.toString("base64")}`,
    storagePath: null,
  })
  if (!cloud) return Promise.resolve(dataUrl())
  return uploadToBucket(input, cloud).then((uploaded) =>
    uploaded
      ? {
          id: input.id,
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          url: uploaded.signedUrl,
          storagePath: uploaded.path,
        }
      : dataUrl(),
  )
}

export async function persistGeneratedFiles(
  inputs: FileToPersist[],
  opts: PersistFilesOpts = {},
): Promise<PersistFilesResult> {
  if (inputs.length === 0) return { ok: true, files: [] }
  const cloud = opts.localFilesOnly ? null : await resolveCloudContext()
  const files = await Promise.all(inputs.map((f) => persistOne(f, cloud)))
  return { ok: true, files }
}

/** Re-sign a generated file's storage path (parallel to
 *  `signGeneratedImageUrl`). Caller does the auth check. */
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

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/server/file-storage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/server/file-storage.ts lib/server/file-storage.test.ts
git commit -m "feat(server): persistGeneratedFiles storage layer"
```

---

### Task 7: SSE emitter `toolFile` frame

**Files:**
- Modify: `lib/server/chat/sse-emitter.ts`
- Test: `lib/server/chat/sse-emitter.test.ts`

**Interfaces:**
- Produces: `ToolFilePayload = { id: string; files: Array<{ id; name; sizeBytes; mimeType; url; storagePath?: string }> }`; `emitter.toolFile(payload)` sends `{ type: "data-tool-file", id, data: { id, files } }`.

- [ ] **Step 1: Write the failing test**

Append to `lib/server/chat/sse-emitter.test.ts` (follow the existing
`toolImage` test's setup — construct the emitter the same way the
neighbouring tests do, capturing sent frames):

```typescript
import { describe, expect, it } from "bun:test"

import { ChatSseEmitter } from "./sse-emitter"

describe("ChatSseEmitter.toolFile", () => {
  it("sends a data-tool-file frame with the files payload", () => {
    const sent: unknown[] = []
    // Mirror the construction used by the existing toolImage test in this
    // file; if it builds via `new ChatSseEmitter(write)`, do the same here.
    const emitter = new ChatSseEmitter((frame) => sent.push(frame))
    emitter.toolFile({
      id: "call-0",
      files: [
        {
          id: "call-0-0",
          name: "report.csv",
          sizeBytes: 12,
          mimeType: "text/csv",
          url: "data:text/csv;base64,AAAA",
          storagePath: "u/generated/call-0-0-report.csv",
        },
      ],
    })
    expect(sent).toEqual([
      {
        type: "data-tool-file",
        id: "call-0",
        data: {
          id: "call-0",
          files: [
            {
              id: "call-0-0",
              name: "report.csv",
              sizeBytes: 12,
              mimeType: "text/csv",
              url: "data:text/csv;base64,AAAA",
              storagePath: "u/generated/call-0-0-report.csv",
            },
          ],
        },
      },
    ])
  })
})
```

> If the existing tests construct the emitter differently (e.g. via a
> factory or with a `ReadableStream` controller), copy THAT construction —
> the assertion on the emitted frame shape is the point, not the wiring.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/server/chat/sse-emitter.test.ts`
Expected: FAIL — `emitter.toolFile is not a function`.

- [ ] **Step 3: Implement**

In `lib/server/chat/sse-emitter.ts`, after the `ToolImagePayload`
interface (ends line 55), add:

```typescript
export interface ToolFilePayload {
  id: string
  files: Array<{
    id: string
    name: string
    sizeBytes: number
    mimeType: string
    url: string
    storagePath?: string
  }>
}
```

After the `toolImage` method (ends line 165), add:

```typescript
  toolFile(payload: ToolFilePayload): void {
    this.send({
      type: "data-tool-file",
      id: payload.id,
      data: {
        id: payload.id,
        files: payload.files,
      },
    })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/server/chat/sse-emitter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/chat/sse-emitter.ts lib/server/chat/sse-emitter.test.ts
git commit -m "feat(sse): emit data-tool-file frame"
```

---

### Task 8: Persist + emit files in the chat route

**Files:**
- Modify: `app/api/chat/route.ts`

**Interfaces:**
- Consumes: `persistGeneratedFiles`/`FileToPersist` (Task 6), `emitter.toolFile` (Task 7), `CodeRunResult.files` (Task 1).

> No new test file: the route's streaming surface is covered by the
> existing integration tests, and the unit-testable logic lives in
> `file-storage.ts` (Task 6). Mirror `maybeEmitCodeResultFrames`'
> existing image branch exactly.

- [ ] **Step 1: Add the import**

In `app/api/chat/route.ts`, after the image-storage import (line 41):

```typescript
import { persistGeneratedFiles, type FileToPersist } from '@/server/file-storage'
```

- [ ] **Step 2: Emit files inside `maybeEmitCodeResultFrames`**

In `maybeEmitCodeResultFrames`, immediately after the image `if (imgs.length > 0) { ... }` block closes (line 264) and before the `// stdout/stderr...` comment (line 265), insert:

```typescript
  // Whole files the run wrote to /tmp/outputs → persist + emit a
  // `data-tool-file` frame the client renders as download chips and
  // auto-saves as `file` artifacts. Non-fatal: a failed persist just
  // drops the chips, leaving stdout intact.
  const outFiles = result.files ?? []
  if (outFiles.length > 0) {
    const inputs: FileToPersist[] = outFiles.map((f, i) => ({
      id: `${id}-file-${i}`,
      name: f.name,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      bytes: Buffer.from(f.data, 'base64'),
    }))
    const persisted = await persistGeneratedFiles(inputs, {
      signal,
      localFilesOnly,
    })
    if (persisted.ok && persisted.files.length > 0) {
      emitter.toolFile({
        id,
        files: persisted.files.map((f) => ({
          id: f.id,
          name: f.name,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          url: f.url,
          ...(f.storagePath ? { storagePath: f.storagePath } : {}),
        })),
      })
    }
  }
```

- [ ] **Step 3: Verify typecheck + lint**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Document the frame in docs/API.md**

In `docs/API.md`, in the SSE-frame section that lists `data-tool-image`
and `data-code-result`, add an entry for `data-tool-file` describing its
`{ id, files: GeneratedFile[]-ish }` payload (mirror the `data-tool-image`
entry's wording).

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/route.ts docs/API.md
git commit -m "feat(chat): persist + emit generated files from runCode"
```

---

### Task 9: Migration + sync parity for `generated_files`

**Files:**
- Create: `supabase/migrations/0018_message_generated_files.sql`
- Modify: `lib/client/sync/reconcile.ts`, `lib/client/sync/handlers.ts`

**Interfaces:**
- Consumes: `GeneratedFile` (Task 5).
- Produces: `messages.generated_files` JSONB column; `artifacts.kind` constraint allows `'file'`; `reconcile.ts` reads/writes `generated_files`; `handlers.ts` diffs it.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0018_message_generated_files.sql`:

```sql
-- Cross-device sync of `Message.generatedFiles` + the `file` artifact kind.
--
-- The `runCode` code interpreter can now write deliverable files to
-- `/tmp/outputs/`; the server persists the bytes to Storage (mirroring
-- generated images) and the metadata rides on the message row. A single
-- nullable JSONB column carries the `GeneratedFile[]` shape from
-- `lib/shared/types.ts`. Kept nullable + defaulting to NULL (not
-- '[]'::jsonb) to match `0010_message_generated_images.sql` — the sync
-- diff only writes a value when the message actually has files.
--
-- Also widens the `artifacts.kind` check to admit the new 'file' kind so
-- a generated file can be auto-saved as a workspace artifact.
--
-- Idempotent: column add is guarded; the constraint is dropped-if-exists
-- before recreate.

alter table messages
  add column if not exists generated_files jsonb;

alter table artifacts
  drop constraint if exists artifacts_kind_check;

alter table artifacts
  add constraint artifacts_kind_check
  check (kind in ('code', 'markdown', 'image', 'table', 'json', 'file', 'other'));
```

> Confirm the existing constraint name with
> `grep -n "kind" supabase/migrations/0001_schema.sql`. If the inline
> `check (...)` on line 188 is unnamed, Postgres auto-names it
> `artifacts_kind_check` (table + column + `_check`), so the
> `drop constraint if exists artifacts_kind_check` above is correct. If a
> later migration renamed it, adjust the drop to match.

- [ ] **Step 2: Add the boundary parser in reconcile.ts**

In `lib/client/sync/reconcile.ts`, next to `parseGeneratedImages` (the
parser whose doc-comment is at line 122), add a sibling
`parseGeneratedFiles(value: Json): GeneratedFile[] | undefined` that
validates the `GeneratedFile` shape the same defensive way
`parseGeneratedImages` validates images (array guard, per-field
`typeof` checks, `storagePath` nullable). Use it where messages are
parsed (line ~322, beside `const persistedImages = ...`):

```typescript
      const persistedFiles = parseGeneratedFiles(m.generated_files)
      if (persistedFiles) {
        msg.generatedFiles = persistedFiles
      }
```

Add `generated_files: Json` to the row type alongside `generated_images`
(line ~722), and to the upsert row builder (line ~743) mirror the image
block:

```typescript
        generated_files:
          m.generatedFiles && m.generatedFiles.length > 0
            ? (m.generatedFiles as unknown as Json)
            : null,
```

- [ ] **Step 3: Diff `generated_files` in handlers.ts**

In `lib/client/sync/handlers.ts`, at the message-row upsert builder
(line ~325, beside `generated_images:`), add the parallel block:

```typescript
          generated_files:
            m.generatedFiles && m.generatedFiles.length > 0
              ? (m.generatedFiles as unknown as Json)
              : null,
```

Ensure `GeneratedFile` is imported where `GeneratedImage` already is in
each file.

- [ ] **Step 4: Verify typecheck + lint**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0018_message_generated_files.sql lib/client/sync/reconcile.ts lib/client/sync/handlers.ts
git commit -m "feat(sync): persist + round-trip message generated_files"
```

---

## Slice 2 — Client wiring + inline UX

### Task 10: Translate the `data-tool-file` frame

**Files:**
- Modify: `lib/client/chat/sse-frame-translator.ts`
- Test: `lib/client/chat/sse-frame-translator.test.ts`

**Interfaces:**
- Produces: a translated frame `{ type: "tool_file"; id?: string; files?: unknown[] }`.

- [ ] **Step 1: Write the failing test**

Append to `lib/client/chat/sse-frame-translator.test.ts` (match the
existing `data-tool-image` test's call shape):

```typescript
import { describe, expect, it } from "bun:test"

import { translateFrame } from "./sse-frame-translator"

describe("translateFrame — data-tool-file", () => {
  it("translates a tool-file frame", () => {
    const out = translateFrame({
      type: "data-tool-file",
      data: {
        id: "call-0",
        files: [
          { id: "call-0-0", name: "report.csv", sizeBytes: 12, mimeType: "text/csv", url: "data:..." },
        ],
      },
    })
    expect(out).toEqual({
      type: "tool_file",
      id: "call-0",
      files: [
        { id: "call-0-0", name: "report.csv", sizeBytes: 12, mimeType: "text/csv", url: "data:..." },
      ],
    })
  })

  it("returns null for a malformed data-tool-file frame", () => {
    expect(translateFrame({ type: "data-tool-file" })).toBeNull()
  })
})
```

> Use the exact exported translator function name + call signature from
> the top of `sse-frame-translator.test.ts` (the existing
> `data-tool-image` test shows it). If it's not `translateFrame`, match
> the real one.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/client/chat/sse-frame-translator.test.ts`
Expected: FAIL — the new case returns nothing / null.

- [ ] **Step 3: Implement**

In `lib/client/chat/sse-frame-translator.ts`, after the
`data-tool-image` case (ends line 168), add:

```typescript
  if (t === "data-tool-file") {
    const data = raw.data as
      | { id?: unknown; files?: unknown }
      | undefined
    if (!data || typeof data !== "object") return null
    return {
      type: "tool_file",
      id: typeof data.id === "string" ? data.id : undefined,
      files: Array.isArray(data.files) ? data.files : undefined,
    }
  }
```

Add `"tool_file"` + its fields to the translated-frame union type that
this module returns (mirror how `tool_image` is declared in that union).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/client/chat/sse-frame-translator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/client/chat/sse-frame-translator.ts lib/client/chat/sse-frame-translator.test.ts
git commit -m "feat(chat): translate data-tool-file frame"
```

---

### Task 11: `appendMessageGeneratedFiles` store mutation

**Files:**
- Modify: `lib/client/hooks/store/slices/messages.ts`
- Test: `lib/client/hooks/store/slices/messages.test.ts` (create if absent; if absent, add to the nearest existing messages-slice test and adjust the path — verify with `ls lib/client/hooks/store/slices/messages.test.ts`).

**Interfaces:**
- Consumes: `GeneratedFile` (Task 5).
- Produces: `appendMessageGeneratedFiles(messageId: string, files: GeneratedFile[]): void` on the messages slice.

- [ ] **Step 1: Write the failing test**

Create/extend `lib/client/hooks/store/slices/messages.test.ts` mirroring
how an existing slice test builds the store. Minimal shape:

```typescript
import { describe, expect, it } from "bun:test"

import { useStore } from "@/client/hooks/use-store"

describe("appendMessageGeneratedFiles", () => {
  it("appends files to the target message", () => {
    // Seed a conversation + message via the store's existing actions, then:
    const file = {
      id: "f1",
      name: "report.csv",
      sizeBytes: 12,
      mimeType: "text/csv",
      url: "data:...",
      storagePath: null,
    }
    useStore.getState().appendMessageGeneratedFiles(/* messageId */ "m1", [file])
    // Assert the message now carries generatedFiles: [file].
  })
})
```

> Match the seeding pattern (`addConversation`/`addMessage` or whatever
> the slice exposes) used by the existing messages-slice tests; the
> assertion that matters is `message.generatedFiles` equals `[file]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/client/hooks/store/slices/messages.test.ts`
Expected: FAIL — `appendMessageGeneratedFiles is not a function`.

- [ ] **Step 3: Implement**

In `lib/client/hooks/store/slices/messages.ts`, add to the slice
interface (next to `appendMessageGeneratedImages`, line 74):

```typescript
  appendMessageGeneratedFiles: (messageId: string, files: GeneratedFile[]) => void
```

Ensure `GeneratedFile` is imported from `@/shared/types` in this file
(add to the existing type import alongside `GeneratedImage`).

Add the implementation next to `appendMessageGeneratedImages` (line 287):

```typescript
  appendMessageGeneratedFiles: (messageId, files) =>
    set((state) =>
      updateMessage(state, messageId, (m) => ({
        ...m,
        generatedFiles: [...(m.generatedFiles ?? []), ...files],
      }))
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/client/hooks/store/slices/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/client/hooks/store/slices/messages.ts lib/client/hooks/store/slices/messages.test.ts
git commit -m "feat(store): appendMessageGeneratedFiles mutation"
```

---

### Task 12: Handle `tool_file` in use-chat-send + auto-create artifact

**Files:**
- Modify: `lib/client/hooks/use-chat-send.ts`

**Interfaces:**
- Consumes: translated `tool_file` frame (Task 10), `appendMessageGeneratedFiles` (Task 11), `createArtifact` (existing).

> No new unit test: `use-chat-send` is exercised by integration-level
> flows; the unit-testable pieces (translator, store mutation) are
> covered in Tasks 10–11. Mirror the `tool_image` handler exactly.

- [ ] **Step 1: Pull the mutation from the store**

Where `use-chat-send.ts` reads `appendMessageGeneratedImages` from the
store, also read `appendMessageGeneratedFiles` (same `useStore`
selector/`getState` pattern already used for images).

- [ ] **Step 2: Handle the frame**

After the `tool_image` handling block closes (line 685) and before the
`code_result` block (line 733), add:

```typescript
        } else if (
          parsed.type === "tool_file" &&
          Array.isArray(parsed.files)
        ) {
          const ph = placeholder as Message | null
          if (ph) {
            const files = (parsed.files as Array<Record<string, unknown>>)
              .filter(
                (f): f is {
                  id: string
                  name: string
                  sizeBytes: number
                  mimeType: string
                  url: string
                  storagePath?: string
                } =>
                  typeof f?.id === "string" &&
                  typeof f?.name === "string" &&
                  typeof f?.sizeBytes === "number" &&
                  typeof f?.mimeType === "string" &&
                  typeof f?.url === "string" &&
                  (f.storagePath === undefined ||
                    typeof f.storagePath === "string")
              )
              .map((f) => ({
                id: f.id,
                name: f.name,
                sizeBytes: f.sizeBytes,
                mimeType: f.mimeType,
                url: f.url,
                storagePath: f.storagePath ?? null,
              }))
            if (files.length > 0) {
              appendMessageGeneratedFiles(ph.id, files)
              files.forEach((f) => {
                createArtifact({
                  conversationId: targetConvId,
                  messageId: ph.id,
                  kind: "file",
                  title: f.name,
                  content: "",
                  // Mirrors the image path: the artifact's storagePath
                  // field carries the loadable URL (signed or data:).
                  storagePath: f.url,
                })
              })
            }
          }
        }
```

- [ ] **Step 3: Verify typecheck + lint**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/client/hooks/use-chat-send.ts
git commit -m "feat(chat): append generated files + auto-save file artifacts"
```

---

### Task 13: `GeneratedFilesList` chips component + render in the message

**Files:**
- Create: `components/skills/generated-files-list.tsx`
- Test: `components/skills/generated-files-list.test.tsx`
- Modify: `components/panels/chat-message.tsx`

**Interfaces:**
- Consumes: `GeneratedFile` (Task 5).
- Produces: `GeneratedFilesList({ files }: { files: GeneratedFile[] })`.

- [ ] **Step 1: Write the failing test**

Create `components/skills/generated-files-list.test.tsx`:

```typescript
import { describe, expect, it } from "bun:test"
import { render } from "@testing-library/react"

import { GeneratedFilesList } from "./generated-files-list"

const file = {
  id: "f1",
  name: "report.csv",
  sizeBytes: 2048,
  mimeType: "text/csv",
  url: "data:text/csv;base64,AAAA",
  storagePath: null,
}

describe("GeneratedFilesList", () => {
  it("renders a download link per file with name + human size", () => {
    const { getByText, container } = render(<GeneratedFilesList files={[file]} />)
    expect(getByText("report.csv")).toBeDefined()
    expect(getByText(/2(\.0)?\s?KB/i)).toBeDefined()
    const link = container.querySelector("a[download]") as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe(file.url)
  })

  it("renders nothing for an empty list", () => {
    const { container } = render(<GeneratedFilesList files={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
```

> Match the test renderer the other `components/skills/*.test.tsx` files
> use (e.g. `@testing-library/react`). If the existing image-gallery
> test uses a different import, copy that.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test components/skills/generated-files-list.test.tsx`
Expected: FAIL — cannot find module `./generated-files-list`.

- [ ] **Step 3: Implement**

Create `components/skills/generated-files-list.tsx`:

```typescript
"use client"

import { Download, FileText } from "lucide-react"

import type { GeneratedFile } from "@/shared/types"

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

export function GeneratedFilesList({ files }: { files: GeneratedFile[] }) {
  if (files.length === 0) return null
  return (
    <div className="mt-2 mb-1 flex flex-wrap gap-2">
      {files.map((f) => (
        <a
          key={f.id}
          href={f.url}
          download={f.name}
          className="group flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)] px-2.5 py-1.5 text-xs hover:bg-[var(--accent)]"
        >
          <FileText className="size-4 shrink-0 text-[var(--muted-foreground)]" />
          <span className="max-w-[18ch] truncate font-medium">{f.name}</span>
          <span className="text-[var(--muted-foreground)]">{humanSize(f.sizeBytes)}</span>
          <Download className="size-3.5 shrink-0 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100" />
        </a>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test components/skills/generated-files-list.test.tsx`
Expected: PASS.

- [ ] **Step 5: Render it in the chat message**

In `components/panels/chat-message.tsx`, import the component and add
the render block immediately after the `GeneratedImagesGallery` block
(ends line 496):

```typescript
        {!isUser &&
          message.generatedFiles &&
          message.generatedFiles.length > 0 && (
            <GeneratedFilesList files={message.generatedFiles} />
          )}
```

Add `import { GeneratedFilesList } from "@/components/skills/generated-files-list"`
next to the existing `GeneratedImagesGallery` import (match its exact
import-path style).

- [ ] **Step 6: Verify + commit**

Run: `bun run check`
Expected: PASS.

```bash
git add components/skills/generated-files-list.tsx components/skills/generated-files-list.test.tsx components/panels/chat-message.tsx
git commit -m "feat(chat): render generated-file download chips in messages"
```

---

### Task 14: Artifacts-tab `file` kind branch

**Files:**
- Modify: `components/panels/artifacts-tab.tsx`

**Interfaces:**
- Consumes: `file`-kind `Artifact` (Task 5), whose `storagePath` holds the loadable URL.

- [ ] **Step 1: Add the render branch**

In `components/panels/artifacts-tab.tsx`, in the kind switch, after the
`artifact?.kind === "image"` branch closes (the `</div>` at line 356),
add a `file` branch before the existing fallthrough:

```typescript
        ) : artifact?.kind === "file" ? (
          <div className="flex flex-col items-center gap-3 p-6">
            <a
              href={artifact.storagePath ?? artifact.content}
              download={artifact.title}
              className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm hover:bg-[var(--accent)]"
            >
              <Download className="size-4" />
              <span className="font-medium">{artifact.title}</span>
            </a>
            <p className="text-xs text-[var(--muted-foreground)]">
              Generated by the code interpreter
            </p>
          </div>
```

Ensure `Download` is imported from `lucide-react` in this file (add to
the existing lucide import if not already present).

- [ ] **Step 2: Verify typecheck + lint**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/panels/artifacts-tab.tsx
git commit -m "feat(artifacts): render file-kind artifact as a download row"
```

---

## Slice 3 — Skill prompt

### Task 15: Tell the model to write deliverables to `/tmp/outputs/`

**Files:**
- Modify: `lib/server/skills/code-interpreter.ts`

- [ ] **Step 1: Extend the prompt**

In `lib/server/skills/code-interpreter.ts`, add a sentence to the
`PROMPT` array (after the table-convention lines, before the
`language: 'javascript'` line):

```typescript
  "To return a downloadable file (xlsx, csv, zip, pdf, etc.), write it to",
  "the /tmp/outputs/ directory (create it first, e.g. `os.makedirs",
  "('/tmp/outputs', exist_ok=True)`) — every file there is returned to the",
  "user as a downloadable attachment. Use this for deliverables, not for",
  "charts (use savefig) or tables (use /tmp/<name>.table.json).",
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/server/skills/code-interpreter.ts
git commit -m "feat(skill): document /tmp/outputs for downloadable files"
```

---

## Final verification (after all tasks)

- [ ] **Run the full check + test suite**

```bash
bun run check && bun run test
```
Expected: typecheck + lint clean; all tests pass (the intentional
`postgres unreachable` throw at `route.handler.test.ts:240` is NOT a
failure — it's the documented unreachable-DB assertion).

- [ ] **Manual sandbox smoke test** (requires `CODE_SANDBOX_ENABLED=1` + a
  microsandbox-capable host)

In a chat with the code interpreter enabled, ask: *"Write a CSV with two
columns and ten rows to a file I can download."* Verify:
1. A download chip appears in the assistant message; clicking it
   downloads the CSV.
2. The Artifacts tab (right-hand Resources sidebar) shows a `file`
   artifact with a working download link.
3. With Supabase configured, reload the page — the chip + artifact
   survive (sync round-trip). Anonymous/local mode: the `data:` URL chip
   survives via localStorage.

---

## Self-Review (run before handing off)

**Spec coverage:**
- Capture from designated output dir → Tasks 2–4. ✓
- Artifacts-tab `file` kind → Tasks 5, 14. ✓
- Inline download chips → Tasks 10–13. ✓
- Mirror generated-images data model (`Message.generatedFiles` + auto-artifact) → Tasks 5, 11, 12. ✓
- Storage upload + data-URL fallback → Task 6. ✓
- SSE frame + docs → Tasks 7, 8, 10. ✓
- Migration + sync parity → Task 9. ✓
- No cap (reuse existing budget) → Task 4 + Global Constraints. ✓
- Skill prompt convention → Task 15. ✓

**Type consistency:** `GeneratedFile` (Task 5) fields — `id/name/sizeBytes/mimeType/url/storagePath` — are used identically in `file-storage.ts` `PersistedFile` (Task 6), the `toolFile` payload (Task 7), the translator (Task 10), the store mutation (Task 11), the send handler (Task 12), and the chips component (Task 13). `CodeFile` (Task 1) — `name/mimeType/sizeBytes/data` — matches the marshaller output (Task 3) and the route's `FileToPersist` mapping (Task 8). The artifact `storagePath`-holds-the-URL convention (Tasks 12, 14) matches the existing image behavior verbatim.
</content>
