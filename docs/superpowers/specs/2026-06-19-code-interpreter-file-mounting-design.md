# Code interpreter — file mounting (PR-2) — Design

**Status:** Approved design (2026-06-19). **PR-2** of the code-interpreter
series; builds directly on PR-1 (`#243`, microsandbox `runCode`).

**Builds on:**
- `docs/superpowers/specs/2026-06-19-code-interpreter-microsandbox-design.md` (PR-1).
- `docs/PLAN-code-interpreter.md` §"PR 2 — file mounting".

## Goal

Let `runCode` mount **named conversation attachments** into the sandbox
filesystem before executing, so the model can run code against an
attached file (e.g. `pd.read_csv('/mnt/files/data.csv')`). Supports both
**cloud-stored** files (server downloads from the `user-files` bucket)
and **local-only** files (client sends bytes with the request) via a
hybrid byte path. Network stays **OFF**.

## Non-goals (this PR)

- Directory trees / nested mounts — flat files only.
- Writing sandbox-created files back to the user's storage (except the
  existing `savefig` → image-gallery chart path from PR-1).
- Rich `table` results + JavaScript (PR-3); persistent warm sessions
  (PR-4); agent-py/agent-ts parity.

## Decisions locked (brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | File selection | **Model names files** — a `files?: string[]` tool input listing attachment filenames to mount (explicit, per PLAN). |
| D2 | Scope | **Cloud + local** files both mountable. |
| D3 | Byte delivery | **Hybrid** — client sends request bytes only for **local-only** attachments (no `storage_path`); the server downloads **cloud** attachments from `user-files` by `storage_path` at mount time. A unified server resolver picks the source per named file. |

## Architecture

```
runCode({ code, files: ["data.csv"] })           (tool input)
   │  skill.execute → ctx.resolveMountFiles(["data.csv"])
   ▼
resolveMountFiles(names, { sandboxFiles, attachments, userId })   (server, unified)
   per name → match conversation attachment by name, then:
     • request bytes present (local)  → decode base64
     • has storage_path + signed in   → download from user-files (RLS-scoped)
     • else                           → skip + per-file note (non-fatal)
   │  { name, bytes }[]  +  notes[]
   ▼
CodeSandbox.run({ code, language, timeoutMs, signal, files: [{path:"/mnt/files/<name>", bytes}] })
   │  microsandbox client: mkdir /mnt/files; sb.fs().write(path, bytes) per file; then exec
   ▼
CodeRunResult  (run executes with files mounted; unavailable-file notes surfaced)
```

## Components & boundaries

### Wire — `lib/shared/api-schemas.ts`
- `ChatRequestSchema` gains `sandboxFiles?: { fileId: string; name: string; dataBase64: string }[]`.
  - Client populates it **only when the `codeInterpreter` skill is enabled for the turn**, with bytes for **local-only** conversation attachments (those whose file record has no `storage_path`).
  - Caps (env-overridable; enforced at the schema where practical + server-side): per-file ≤ 10 MB (decoded), ≤ 10 files, total ≤ 20 MB. The schema bounds `dataBase64` length; finer total/decoded caps are enforced in the resolver.

### Client — byte collection
- A small client helper picks the conversation's **local-only** attachments (no `storage_path`), reads their bytes (from the local file cache / blob the app already holds for attachments), base64-encodes under the caps, and attaches them as `sandboxFiles` on the chat request — only when `codeInterpreter` is in the enabled-skills set for the send. Over-cap files are omitted (the model will get an "unavailable" note if it names one).
- Wired where the chat request body is assembled (`lib/client/hooks/use-chat-send.ts`, beside `attachments`/`workspaceSystemPrompt`).

### Server — resolver (`lib/server/code-sandbox/mount-files.ts`, new)
- `resolveMountFiles(names: string[], opts): Promise<{ files: { name: string; bytes: Uint8Array }[]; notes: string[] }>`.
- `opts`: the request's `sandboxFiles` (local bytes by name/fileId), the resolved conversation `attachments` (for name → `{ fileId, storage_path }`), and the `userId` (for RLS-scoped cloud download).
- Per named file: local-bytes → cloud-download → unavailable-note. Enforces per-file + total decoded caps (drop + note over cap).
- Cloud download mirrors `lib/server/image-storage.ts`'s storage access (signed URL / download from `user-files`, scoped to the user). The download is **best-effort**: a failure becomes an unavailable-note, never throws the run.
- The byte-source-selection logic is **pure + unit-tested** with the storage download injected (so tests need no network).

### Skill context + tool — `lib/server/skills/registry.ts`, `lib/server/skills/code-interpreter.ts`
- Extend `SkillRuntimeContext` with `resolveMountFiles?: (names: string[]) => Promise<{ files: { name: string; bytes: Uint8Array }[]; notes: string[] }>` (the route binds it with the request's `sandboxFiles` + attachments + session; absent when nothing is mountable).
- `runCode` tool input → `z.object({ code: z.string()…, files: z.array(z.string()).max(10).optional() })`.
- `execute`: after the budget gate, if `files?.length` and `ctx.resolveMountFiles`, resolve → pass `files` to `sandbox.run(...)`; fold any `notes` into the result (e.g. appended to `stderr` or a `text` result) so the model can adapt. No files named → unchanged from PR-1.
- `promptFragment` adds: files named in `files` are mounted at `/mnt/files/<name>`; read them there.

### Adapter — `lib/server/code-sandbox/types.ts`, `microsandbox-client.ts`
- `CodeRunInput` gains `files?: { path: string; bytes: Uint8Array }[]`.
- The client, before `exec`: ensure `/mnt/files` exists and `sb.fs().write(path, bytes)` per file (confirm the SDK's write method against the installed `microsandbox` types, as PR-1 did for `read`/`list`). Writes happen inside the existing boot→exec→teardown flow; teardown unchanged.

### Route — `app/api/chat/route.ts`
- Build `ctx.resolveMountFiles` from `body.sandboxFiles` + the already-resolved `attachments` + the session `userId`, and pass it in the `skill.buildTool(entry, ctx)` call (~line 362). No change to the result-emission path (PR-1's `maybeEmitCodeResultFrames` already handles outputs).

## Error handling / security

- **Unavailable files** (unknown name, local file whose bytes weren't sent, cloud file when signed-out, over-cap) → a per-file note in the result; the run still executes. Never fatal.
- **Caps** enforced client-side (what it sends) **and** server-side (what it mounts) — defense in depth against an oversized request.
- **Isolation:** cloud download is RLS-scoped to the signed-in user (no cross-user file access); local bytes are the user's own request. Mounted files live only in the ephemeral microVM (torn down after the run). Network remains OFF.

## Testing

- **Resolver (pure, mocked download):** local-bytes vs cloud-download selection; unknown name → note; signed-out + cloud → note; per-file + total cap → drop + note; happy path returns bytes.
- **Wire schema:** `sandboxFiles` accepted; over-cap (`dataBase64` too long / too many) rejected; absent is fine (back-compat).
- **Tool input:** `files` array accepted + capped; no-files path unchanged.
- **Client byte-collection (pure):** selects only local-only attachments, respects caps, base64-encodes; cloud attachments excluded.
- **Manual smoke (needs the local microsandbox runtime):** attach a small CSV, ask the model to `runCode` reading `/mnt/files/<name>` → correct output; name a non-existent file → graceful note + run continues.

## Risks

- **Request bloat** for local files (base64 ≈ +33%); bounded by the caps. Cloud files avoid this (server download).
- **microsandbox `fs().write` surface** — confirm method name/signature against the installed SDK (PR-1 found real-API deltas; same diligence here). The `{path,bytes}` contract to the client is the stable seam.
- **Name collisions / path safety** — sanitize mounted names to a single path segment under `/mnt/files/` (strip directory separators) so a crafted name can't escape the mount dir.
- **Attachment→storage_path mapping** — the resolver needs each cloud attachment's `fileId`/`storage_path`; confirm the resolved `attachments` (or the file records) expose it server-side, else thread it through.
