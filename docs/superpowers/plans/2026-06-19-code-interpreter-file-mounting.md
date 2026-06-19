# Code interpreter — file mounting (PR-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `runCode` mount named conversation attachments into the microsandbox fs before executing (e.g. `pd.read_csv('/mnt/files/data.csv')`) — cloud + local files via a hybrid byte path. Network stays OFF.

**Architecture:** A self-contained `sandboxFiles` manifest on the chat request (each entry: `name`, `fileId`, optional `dataBase64`). A unified server resolver turns a model-named filename into bytes: local entries decode their base64; cloud entries (no bytes) are looked up by `fileId` in the `files` table under the user's RLS, then downloaded from the `user-files` bucket. Resolved `{path,bytes}` are written into the microVM via the SDK fs before `exec`.

**Tech Stack:** TypeScript, Next.js, AI SDK v5, Zod, microsandbox Node SDK, Supabase Storage, bun:test.

**Spec:** `docs/superpowers/specs/2026-06-19-code-interpreter-file-mounting-design.md` · **Builds on:** PR-1 (`#243`).

> **Spec correction (discovered during planning):** `FileSummarySchema` carries **no `fileId`/`storage_path`**, so the resolver can't map a filename to a Storage object via the `attachments` payload. The `sandboxFiles` manifest therefore carries the full mapping itself (name → fileId [+ optional local bytes]); cloud bytes are resolved by an **RLS-scoped `files` lookup by `fileId`** (never a client-supplied path). This refines, not changes, the locked decisions (D1–D3 hold).

---

## File structure

**New:**
- `lib/server/code-sandbox/mount-files.ts` — `resolveMountFiles()` (the unified resolver) + `MountFileSpec` type.
- `lib/server/code-sandbox/mount-files.test.ts` — resolver unit tests (download injected).
- `lib/client/chat/build-sandbox-files.ts` — client manifest builder.
- `lib/client/chat/build-sandbox-files.test.ts` — builder unit tests.

**Modified:**
- `lib/shared/api-schemas.ts` — `ChatRequestSchema.sandboxFiles`.
- `lib/server/code-sandbox/types.ts` — `CodeRunInput.files`.
- `lib/server/code-sandbox/microsandbox-client.ts` — write mounted files before exec.
- `lib/server/code-sandbox/config.ts` — mount caps.
- `lib/server/skills/registry.ts` — `SkillRuntimeContext.resolveMountFiles`.
- `lib/server/skills/code-interpreter.ts` (+ `.test.ts`) — `files` input, execute wiring, prompt.
- `app/api/chat/route.ts` — build `resolveMountFiles` into the skill ctx.
- `lib/client/hooks/use-chat-send.ts` — attach `sandboxFiles` when `codeInterpreter` is enabled.

---

## Task 1: Wire schema — `sandboxFiles` manifest

**Files:** Modify `lib/shared/api-schemas.ts`; add a test (extend `lib/shared/api-schemas.test.ts`)

- [ ] **Step 1: Write the failing test** (append to `lib/shared/api-schemas.test.ts`)

```ts
import { ChatRequestSchema } from "./api-schemas"

describe("ChatRequestSchema.sandboxFiles", () => {
  const base = { messages: [{ role: "user", content: "hi" }] }
  test("accepts a manifest of local + cloud entries", () => {
    const r = ChatRequestSchema.safeParse({
      ...base,
      sandboxFiles: [
        { name: "data.csv", fileId: "f1", dataBase64: "YQ==" }, // local
        { name: "big.parquet", fileId: "f2" },                  // cloud (no bytes)
      ],
    })
    expect(r.success).toBe(true)
  })
  test("absent is fine (back-compat)", () => {
    expect(ChatRequestSchema.safeParse(base).success).toBe(true)
  })
  test("rejects more than 10 entries", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, fileId: `id${i}` }))
    expect(ChatRequestSchema.safeParse({ ...base, sandboxFiles: many }).success).toBe(false)
  })
  test("rejects an over-cap dataBase64 blob", () => {
    const huge = "A".repeat(15_000_000) // ~11MB decoded > 10MB cap
    const r = ChatRequestSchema.safeParse({
      ...base,
      sandboxFiles: [{ name: "x", fileId: "f", dataBase64: huge }],
    })
    expect(r.success).toBe(false)
  })
})
```
> Match `api-schemas.test.ts`'s real `base` message shape (inspect an existing `ChatRequestSchema` test there; the `messages`/required fields may differ — copy a passing fixture and only vary `sandboxFiles`).

- [ ] **Step 2: Run → FAIL.** **Step 3: Add the field**

In `lib/shared/api-schemas.ts`, inside `ChatRequestSchema` (near `attachments`, ~line 231):

```ts
  /** Files the client offers for `runCode` to mount (PR-2). Sent only
   *  when the codeInterpreter skill is enabled. Each entry maps a
   *  conversation attachment's `name` to its `fileId`; `dataBase64` is
   *  present for LOCAL-only files (no storage_path) and absent for CLOUD
   *  files (the server resolves those by fileId via the user's RLS and
   *  downloads from user-files). Caps mirror the sandbox mount limits. */
  sandboxFiles: z
    .array(
      z.object({
        name: z.string().min(1).max(500),
        fileId: z.string().min(1).max(64),
        // ~10 MB decoded ≈ 13.4M base64 chars; bound the string to keep
        // the request sane. Finer decoded/total caps live server-side.
        dataBase64: z.string().max(14_000_000).optional(),
      }),
    )
    .max(10)
    .optional(),
```

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
bun test lib/shared/api-schemas.test.ts && bun run typecheck
git add lib/shared/api-schemas.ts lib/shared/api-schemas.test.ts
git commit -m "feat(api): sandboxFiles manifest on ChatRequestSchema (PR-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Sandbox adapter — mount files into the microVM

**Files:** Modify `lib/server/code-sandbox/types.ts`, `config.ts`, `microsandbox-client.ts`

- [ ] **Step 1: Extend `CodeRunInput`**

In `lib/server/code-sandbox/types.ts`, add to `CodeRunInput`:

```ts
  /** Files to write into the sandbox fs before running. `path` is an
   *  absolute guest path (already sanitized by the caller). */
  files?: { path: string; bytes: Uint8Array }[]
```

- [ ] **Step 2: Add mount caps to `config.ts`**

```ts
/** Per-mounted-file decoded byte cap. */
export const MOUNT_FILE_MAX = Number(process.env.CODE_SANDBOX_MOUNT_FILE_MAX) || 10_000_000
/** Total decoded bytes across all mounted files in one run. */
export const MOUNT_TOTAL_MAX = Number(process.env.CODE_SANDBOX_MOUNT_TOTAL_MAX) || 20_000_000
/** Max number of mounted files in one run. */
export const MOUNT_COUNT_MAX = Number(process.env.CODE_SANDBOX_MOUNT_COUNT_MAX) || 10
/** Guest directory mounted files land in. */
export const MOUNT_DIR = "/mnt/files"
```

- [ ] **Step 3: Write the files in the client (before exec)**

In `lib/server/code-sandbox/microsandbox-client.ts`, after the sandbox boots and **before** the `exec` call, write each input file. Confirm the SDK fs write method against the installed `microsandbox` types (PR-1 used `sb.fs().read()/list()`; the write is likely `sb.fs().write(path, bytes)` and may need a `mkdir`):

```ts
        if (input.files?.length) {
          // Ensure the mount dir exists, then write each file's bytes.
          try {
            await sb.fs().mkdir(MOUNT_DIR) // confirm method; ignore "exists"
          } catch {
            // dir may already exist
          }
          for (const f of input.files) {
            await sb.fs().write(f.path, f.bytes) // confirm method name/signature
          }
        }
```
Import `MOUNT_DIR` from `./config`. If the SDK's write/mkdir names differ, adapt the calls but keep `CodeRunInput.files` (`{path,bytes}[]`) as the stable seam. A write failure should surface as an `upstream` error via the existing catch (don't silently run without the files the user asked for).

- [ ] **Step 4: Typecheck + commit**

```bash
bun run typecheck
git add lib/server/code-sandbox/types.ts lib/server/code-sandbox/config.ts lib/server/code-sandbox/microsandbox-client.ts
git commit -m "feat(code-sandbox): write mounted files into the microVM before exec

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The resolver (TDD)

**Files:** Create `lib/server/code-sandbox/mount-files.ts` + `mount-files.test.ts`

The resolver is the pure core: given the model's named files + the request manifest + a download function, produce `{ files: {name,bytes}[]; notes: string[] }`, enforcing caps and recording unavailable files. The Supabase download is **injected** so tests need no network.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"

import { resolveMountFiles, type MountManifestEntry } from "./mount-files"

const enc = (s: string) => Buffer.from(s).toString("base64")

const manifest: MountManifestEntry[] = [
  { name: "local.csv", fileId: "f1", dataBase64: enc("a,b\n1,2\n") }, // local
  { name: "cloud.parquet", fileId: "f2" },                            // cloud
]

// Injected cloud download: fileId → bytes (or null when not found/denied).
const download = async (fileId: string): Promise<Uint8Array | null> =>
  fileId === "f2" ? new Uint8Array([1, 2, 3]) : null

describe("resolveMountFiles", () => {
  test("local file → decoded bytes at MOUNT_DIR/name", async () => {
    const r = await resolveMountFiles(["local.csv"], manifest, download)
    expect(r.files).toHaveLength(1)
    expect(r.files[0].path).toBe("/mnt/files/local.csv")
    expect(new TextDecoder().decode(r.files[0].bytes)).toBe("a,b\n1,2\n")
    expect(r.notes).toHaveLength(0)
  })
  test("cloud file → downloaded bytes", async () => {
    const r = await resolveMountFiles(["cloud.parquet"], manifest, download)
    expect(r.files[0].bytes).toEqual(new Uint8Array([1, 2, 3]))
  })
  test("unknown name → note, no file", async () => {
    const r = await resolveMountFiles(["nope.txt"], manifest, download)
    expect(r.files).toHaveLength(0)
    expect(r.notes.join(" ")).toContain("nope.txt")
  })
  test("cloud download returns null → note (e.g. signed-out / denied)", async () => {
    const m: MountManifestEntry[] = [{ name: "x.bin", fileId: "missing" }]
    const r = await resolveMountFiles(["x.bin"], m, download)
    expect(r.files).toHaveLength(0)
    expect(r.notes.join(" ")).toContain("x.bin")
  })
  test("over per-file cap → dropped + note", async () => {
    const big: MountManifestEntry[] = [{ name: "big", fileId: "b", dataBase64: enc("Z".repeat(11_000_000)) }]
    const r = await resolveMountFiles(["big"], big, download)
    expect(r.files).toHaveLength(0)
    expect(r.notes.join(" ").toLowerCase()).toContain("too large")
  })
  test("path traversal in name is sanitized to a single segment", async () => {
    const m: MountManifestEntry[] = [{ name: "../../etc/passwd", fileId: "f", dataBase64: enc("x") }]
    const r = await resolveMountFiles(["../../etc/passwd", "passwd"], m, download)
    // Whichever name the model uses, the written path stays under MOUNT_DIR.
    for (const f of r.files) expect(f.path.startsWith("/mnt/files/")).toBe(true)
    for (const f of r.files) expect(f.path.includes("..")).toBe(false)
  })
})
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Write `mount-files.ts`**

```ts
import "server-only"

import { MOUNT_COUNT_MAX, MOUNT_DIR, MOUNT_FILE_MAX, MOUNT_TOTAL_MAX } from "./config"

export interface MountManifestEntry {
  name: string
  fileId: string
  /** Present for local-only files; absent for cloud files. */
  dataBase64?: string
}

export interface ResolvedMounts {
  files: { path: string; bytes: Uint8Array }[]
  notes: string[]
}

/** Reduce a guest filename to a single safe path segment under MOUNT_DIR
 *  (strip any directory components, so a crafted name can't escape). */
function safeMountPath(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file"
  const cleaned = base.replace(/[^\w.\-]+/g, "_").slice(0, 200) || "file"
  return `${MOUNT_DIR}/${cleaned}`
}

/** Resolve model-named files to bytes. `download(fileId)` fetches a cloud
 *  file's bytes (RLS-scoped by the caller) or returns null when
 *  unavailable. Pure except for the injected download — caps + selection
 *  are unit-tested. Never throws; failures become notes. */
export async function resolveMountFiles(
  names: string[],
  manifest: MountManifestEntry[],
  download: (fileId: string) => Promise<Uint8Array | null>,
): Promise<ResolvedMounts> {
  const byName = new Map(manifest.map((m) => [m.name, m]))
  const files: { path: string; bytes: Uint8Array }[] = []
  const notes: string[] = []
  let total = 0

  for (const name of names) {
    if (files.length >= MOUNT_COUNT_MAX) {
      notes.push(`Skipped "${name}": too many files mounted (max ${MOUNT_COUNT_MAX}).`)
      continue
    }
    const entry = byName.get(name)
    if (!entry) {
      notes.push(`"${name}" is not an available attachment; skipped.`)
      continue
    }
    let bytes: Uint8Array | null = null
    if (entry.dataBase64 !== undefined) {
      bytes = new Uint8Array(Buffer.from(entry.dataBase64, "base64"))
    } else {
      bytes = await download(entry.fileId).catch(() => null)
    }
    if (!bytes) {
      notes.push(`"${name}" could not be loaded into the sandbox; skipped.`)
      continue
    }
    if (bytes.length > MOUNT_FILE_MAX) {
      notes.push(`"${name}" is too large to mount (max ${MOUNT_FILE_MAX} bytes); skipped.`)
      continue
    }
    if (total + bytes.length > MOUNT_TOTAL_MAX) {
      notes.push(`"${name}" skipped: total mounted size would exceed ${MOUNT_TOTAL_MAX} bytes.`)
      continue
    }
    total += bytes.length
    files.push({ path: safeMountPath(name), bytes })
  }
  return { files, notes }
}
```

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
bun test lib/server/code-sandbox/mount-files.test.ts && bun run typecheck
git add lib/server/code-sandbox/mount-files.ts lib/server/code-sandbox/mount-files.test.ts
git commit -m "feat(code-sandbox): resolveMountFiles (local/cloud, caps, path-safe, notes)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Skill — `files` input + ctx resolver + wiring

**Files:** Modify `lib/server/skills/registry.ts`, `lib/server/skills/code-interpreter.ts` (+ `.test.ts`)

- [ ] **Step 1: Extend `SkillRuntimeContext`**

In `lib/server/skills/registry.ts`, add to the `SkillRuntimeContext` interface:

```ts
  /** Resolve model-named attachment filenames to sandbox mount specs.
   *  Provided by the chat route for the codeInterpreter skill when the
   *  request carries a sandboxFiles manifest; absent otherwise. */
  resolveMountFiles?: (
    names: string[],
  ) => Promise<import("@/server/code-sandbox/mount-files").ResolvedMounts>
```

- [ ] **Step 2: Write the failing test** (append to `lib/server/skills/code-interpreter.test.ts`)

```ts
test("tool input accepts a files array", () => {
  process.env.CODE_SANDBOX_BASE_URL = "http://localhost:5555"
  const t = codeInterpreterSkill.buildTool(undefined, {})
  // zod schema should parse { code, files }
  const parsed = (t as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } })
    .inputSchema.safeParse({ code: "print(1)", files: ["data.csv"] })
  expect(parsed.success).toBe(true)
})

test("promptFragment mentions the /mnt/files mount path", () => {
  const p = codeInterpreterSkill.promptFragment(undefined) ?? ""
  expect(p).toContain("/mnt/files")
})
```
> Adapt the `inputSchema` access to however the AI SDK `tool()` exposes its schema in the installed version; if it's not readable off the tool object, instead assert behavior via `buildTool` not throwing + the prompt test, and cover the schema via a direct `z` object exported from the module.

- [ ] **Step 3: Run → FAIL.** **Step 4: Update the skill**

In `lib/server/skills/code-interpreter.ts`:
- Widen `inputSchema` to `z.object({ code: z.string().min(1).max(50_000), files: z.array(z.string().max(500)).max(10).optional() })`.
- In `execute({ code, files }, { abortSignal })`, after the budget gate:

```ts
        let mountFiles: { path: string; bytes: Uint8Array }[] | undefined
        const mountNotes: string[] = []
        if (files?.length && ctx.resolveMountFiles) {
          const resolved = await ctx.resolveMountFiles(files)
          mountFiles = resolved.files
          mountNotes.push(...resolved.notes)
        }
        const sandbox = selectSandbox()
        if (!sandbox) {
          return { ok: false, stdout: "", stderr: "", results: [], error: { code: "upstream", message: "Sandbox unavailable." } }
        }
        const result = await sandbox.run({
          code, language: "python", timeoutMs: RUN_TIMEOUT_MS, signal: abortSignal,
          ...(mountFiles ? { files: mountFiles } : {}),
        })
        // Surface mount notes so the model can adapt (prepend to stderr).
        if (mountNotes.length) {
          return { ...result, stderr: [...mountNotes, result.stderr].filter(Boolean).join("\n") }
        }
        return result
```
- Update `promptFragment` to add: "If you pass `files`, they are mounted at `/mnt/files/<name>` — read them there (e.g. `pd.read_csv('/mnt/files/data.csv')`)."

- [ ] **Step 5: Run → PASS; typecheck; commit**

```bash
bun test lib/server/skills/code-interpreter.test.ts && bun run typecheck
git add lib/server/skills/registry.ts lib/server/skills/code-interpreter.ts lib/server/skills/code-interpreter.test.ts
git commit -m "feat(skills): runCode mounts named files via ctx.resolveMountFiles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Route — build the resolver into the skill ctx

**Files:** Modify `app/api/chat/route.ts`

- [ ] **Step 1: Build `resolveMountFiles` and pass it in the ctx**

Near where the skill ctx is constructed (`skill.buildTool(entry, { signal, consumeBudget })`, ~line 362), add a `resolveMountFiles` built from `body.sandboxFiles` + an RLS-scoped cloud download. Provide it ONLY for the `codeInterpreter` skill (cheap to provide for all; gate to keep it tidy):

```ts
import { resolveMountFiles } from '@/server/code-sandbox/mount-files'

// once per request, before the skill loop:
const sandboxManifest = body.sandboxFiles ?? []
const mountResolver = async (names: string[]) =>
  resolveMountFiles(names, sandboxManifest, async (fileId) => {
    // Cloud file: look up storage_path by id under the user's RLS, then
    // download bytes from user-files. Returns null when signed-out, the
    // file isn't the user's, or it has no storage_path (local-only).
    return downloadUserFileBytes(fileId)   // see Step 2
  })

// in the ctx for codeInterpreter:
const tool = skill.buildTool(entryById.get(skill.id), {
  signal,
  consumeBudget,
  ...(skill.id === 'codeInterpreter' ? { resolveMountFiles: mountResolver } : {}),
})
```

- [ ] **Step 2: Implement `downloadUserFileBytes(fileId)`**

Add a helper (in the route, or a small `lib/server/code-sandbox/download-user-file.ts`) that uses the **request's authenticated Supabase client** (the same one the route/`searchFiles` already establish for RLS — find it and reuse; do NOT use a service-role client, so RLS scopes to the user):

```ts
async function downloadUserFileBytes(fileId: string): Promise<Uint8Array | null> {
  const supabase = /* the request-scoped authed client used elsewhere in the route */
  if (!supabase) return null
  const { data: row } = await supabase
    .from('files').select('storage_path').eq('id', fileId).single()
  const path = row?.storage_path
  if (!path) return null
  const { data, error } = await supabase.storage.from('user-files').download(path)
  if (error || !data) return null
  return new Uint8Array(await data.arrayBuffer())
}
```
> Match how the route already obtains its authed supabase client (grep the route + `lib/server/skills/file-search.ts` for the RLS client acquisition). The `files` select + `storage.from('user-files').download` are both RLS-bounded to the user, so a forged `fileId` for another user's file returns null.

- [ ] **Step 3: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add app/api/chat/route.ts lib/server/code-sandbox/download-user-file.ts 2>/dev/null || git add app/api/chat/route.ts
git commit -m "feat(chat): wire runCode file mounting (manifest + RLS cloud download)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Client — build + attach the `sandboxFiles` manifest (TDD)

**Files:** Create `lib/client/chat/build-sandbox-files.ts` + `.test.ts`; modify `lib/client/hooks/use-chat-send.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"

import { buildSandboxFiles, type SandboxFileSource } from "./build-sandbox-files"

const local: SandboxFileSource = { fileId: "f1", name: "a.csv", storagePath: null, readBytes: async () => new Uint8Array([97]) }
const cloud: SandboxFileSource = { fileId: "f2", name: "b.parquet", storagePath: "u/f2", readBytes: async () => new Uint8Array([1]) }

describe("buildSandboxFiles", () => {
  test("local files carry base64 bytes; cloud files carry no bytes", async () => {
    const out = await buildSandboxFiles([local, cloud])
    const a = out.find((e) => e.name === "a.csv")!
    const b = out.find((e) => e.name === "b.parquet")!
    expect(a.dataBase64).toBeDefined()
    expect(b.dataBase64).toBeUndefined()
    expect(b.fileId).toBe("f2")
  })
  test("local files over the per-file cap are omitted", async () => {
    const huge: SandboxFileSource = { fileId: "f3", name: "big", storagePath: null, readBytes: async () => new Uint8Array(11_000_000) }
    const out = await buildSandboxFiles([huge])
    expect(out.find((e) => e.name === "big")).toBeUndefined()
  })
  test("empty input → empty manifest", async () => {
    expect(await buildSandboxFiles([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Write `build-sandbox-files.ts`**

```ts
import "client-only"

/** Per-file / count caps mirrored from the server (kept in sync with
 *  lib/server/code-sandbox/config.ts). */
const MOUNT_FILE_MAX = 10_000_000
const MOUNT_COUNT_MAX = 10

export interface SandboxFileSource {
  fileId: string
  name: string
  /** Non-null → cloud (server downloads; no bytes sent). Null → local. */
  storagePath: string | null
  /** Lazily read the local file's bytes (only called for local files). */
  readBytes: () => Promise<Uint8Array>
}

export interface SandboxFileEntry {
  name: string
  fileId: string
  dataBase64?: string
}

function toBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Build the runCode mount manifest: cloud files become bytes-less entries
 *  (the server downloads them by fileId under RLS); local files carry
 *  base64 bytes, dropping any over the per-file cap or beyond the count. */
export async function buildSandboxFiles(
  sources: SandboxFileSource[],
): Promise<SandboxFileEntry[]> {
  const out: SandboxFileEntry[] = []
  for (const s of sources) {
    if (out.length >= MOUNT_COUNT_MAX) break
    if (s.storagePath) {
      out.push({ name: s.name, fileId: s.fileId })
      continue
    }
    const bytes = await s.readBytes()
    if (bytes.length > MOUNT_FILE_MAX) continue
    out.push({ name: s.name, fileId: s.fileId, dataBase64: toBase64(bytes) })
  }
  return out
}
```
> For large local files `String.fromCharCode` over the whole array can blow the call stack — if the installed runtime supports it, prefer chunked encoding or a `Buffer`/`FileReader`-based base64. Keep the `SandboxFileEntry[]` output identical.

- [ ] **Step 4: Run → PASS.** **Step 5: Wire into the send path**

In `lib/client/hooks/use-chat-send.ts`, where the request body is assembled (the `attachments: ...` block, ~line 451): when the enabled skills for this send include `codeInterpreter`, build `SandboxFileSource[]` from the conversation's attachments (map each attached file from the store: `fileId` = file id, `name`, `storagePath` from the `UploadedFile.storagePath`, `readBytes` = read from the local blob/IndexedDB cache the app already uses for attachments), call `buildSandboxFiles(...)`, and set `sandboxFiles` on the request body. Skip entirely when `codeInterpreter` isn't enabled.

> Reuse the existing attachment enumeration in this hook (it already builds `attachments` from the same files); add the `storagePath` + a `readBytes` accessor from the file cache helper the app uses (grep for how attachment bytes / blobs are read today, e.g. `lib/client/files/fetch-blob.ts`).

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bun test lib/client/chat/build-sandbox-files.test.ts && bun run typecheck && bun run lint
git add lib/client/chat/build-sandbox-files.ts lib/client/chat/build-sandbox-files.test.ts lib/client/hooks/use-chat-send.ts
git commit -m "feat(chat): client builds the runCode sandboxFiles manifest

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Verification + PR

- [ ] **Step 1:** `bun run typecheck` → clean.
- [ ] **Step 2:** `bun run lint` → 0 errors (pre-existing warnings in `app/api/summarize/route.ts` + `services/agent-ts/*` unrelated).
- [ ] **Step 3:** `bun run test` → all pass (new wire / resolver / builder + existing sandbox/skill tests).
- [ ] **Step 4:** `bun run build` → succeeds.
- [ ] **Step 5:** `bun run audit:bundle` → no server-only paths/secrets in client chunks (`mount-files.ts` + `download-user-file.ts` are `server-only`; the client builder is `client-only`).
- [ ] **Step 6: Manual smoke** (needs the local microsandbox runtime): attach a small CSV (local-only), enable Code interpreter, ask the model to `runCode` reading `/mnt/files/<name>` → correct output. Name a non-existent file → graceful note, run continues. (If signed in with a cloud CSV, verify the server-download path too.)
- [ ] **Step 7: Open the PR into `dev`.** Body: summary (runCode file mounting, cloud+local hybrid, network-off), spec + plan links, the FileSummary/manifest correction note, automated-test list, manual-smoke results. Push `feat/code-interpreter-file-mounting`; commit trailer as above.

---

## Out of scope (this PR)

Directory trees / nested mounts; writing sandbox-created files back to storage (beyond PR-1's `savefig` charts); rich `table` results + JS (PR-3); persistent warm sessions (PR-4); agent-py/agent-ts parity.

## Risks

- **microsandbox `fs().write`/`mkdir` surface** — confirm against the installed SDK (PR-1 found real-API deltas); `CodeRunInput.files` (`{path,bytes}[]`) is the stable seam.
- **Authed supabase client in the route** — the cloud download MUST use the request's user-scoped client so RLS bounds it to the user's own files; using a service-role client would be a cross-user data leak. Confirm which client the route already uses.
- **Base64 of large local files on the client** — naive `String.fromCharCode` can stack-overflow; chunk it. Caps bound the size regardless.
- **Path safety** — `safeMountPath` strips directory components so a crafted attachment name can't escape `/mnt/files/` (tested).
- **Request bloat** — local-file base64 (~+33%); bounded by the per-file/count caps client- and server-side.
```
