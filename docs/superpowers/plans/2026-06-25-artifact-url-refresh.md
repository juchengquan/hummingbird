# Artifact-Tab Download URL Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Artifacts-tab download (`file`) and preview (`image`) self-heal an expired Supabase signed URL by deriving the durable object path from the stored URL and re-signing via the existing refresh endpoints.

**Architecture:** A pure `parseStorageObjectPath` helper pulls the object path out of a stored signed URL; the file-download `<a>` re-signs on click and the image `<img>` re-signs on `onError`, both calling the **existing** `apiClient.files.refreshUrl` / `apiClient.images.refreshUrl` and persisting the fresh URL via a new `updateArtifactStoragePath` store mutation. No new route, schema, migration, or `Database`-type change.

**Tech Stack:** React 19, TypeScript, Zustand, bun:test.

## Global Constraints

- **No new server surface** — reuse `apiClient.files.refreshUrl` (#267) and `apiClient.images.refreshUrl`. No route/schema/migration/`Database`-type change.
- `lib/shared/*` = pure, no fence import; `lib/client/*` = `import "client-only"`; components = `"use client"`.
- The derived path must start with `<uid>` (it's `<uid>/generated/...`), so it satisfies each refresh route's 403 owner-check. Don't strip that segment.
- Unrecognized URL (data: / non-Supabase / malformed) → `parseStorageObjectPath` returns `null` → the surface behaves exactly as today (no regression). This is the graceful-degradation contract.
- The repo has **no `@testing-library` / `.test.tsx` infra** — components are NOT render-tested. Unit-test the pure helper + the store mutation; verify the component wiring with `bun run check` + the manual runbook.
- Tests run via `bun test <path>`; new `*.test.ts` must sit under a configured root (`./lib`, `./components`, `./tests`).
- Run `bun run check` before each commit; it must pass.
- Commit messages: **no `Co-Authored-By` trailer**.
- Reference files to mirror: the chip's `FileChip` + `triggerDownload` in `components/skills/generated-files-list.tsx`; the `<img onError>` one-shot in `components/skills/generated-images-gallery.tsx`; `updateArtifactContent` in `lib/client/hooks/store/slices/artifacts.ts`.

---

## File Structure

- `lib/shared/storage-url.ts` *(new)* — `parseStorageObjectPath`. (Task 1)
- `lib/shared/storage-url.test.ts` *(new)* — its tests. (Task 1)
- `lib/client/download.ts` *(new)* — `triggerDownload` (extracted, shared). (Task 2)
- `components/skills/generated-files-list.tsx` — import the shared `triggerDownload`. (Task 2)
- `lib/client/hooks/store/slices/artifacts.ts` — `updateArtifactStoragePath`. (Task 3)
- `lib/client/hooks/store/slices/artifacts.test.ts` *(new)* — its test. (Task 3)
- `components/panels/artifacts-tab.tsx` — `ArtifactFileDownload` (Task 4) + `ArtifactImage` (Task 5) local components wired into the kind-branches.
- `docs/SMOKE-TEST-generated-files.md` — artifact-refresh manual step. (Task 6)

---

## Task 1: `parseStorageObjectPath` pure helper

**Files:**
- Create: `lib/shared/storage-url.ts`
- Test: `lib/shared/storage-url.test.ts`

**Interfaces:**
- Produces: `parseStorageObjectPath(url: string): string | null`.

- [ ] **Step 1: Write the failing test**

Create `lib/shared/storage-url.test.ts`:

```typescript
import { describe, expect, it } from "bun:test"

import { parseStorageObjectPath } from "./storage-url"

describe("parseStorageObjectPath", () => {
  it("extracts the object path from a user-files signed URL", () => {
    const url =
      "https://proj.supabase.co/storage/v1/object/sign/user-files/u123/generated/call-0-report.csv?token=abc.def.ghi"
    expect(parseStorageObjectPath(url)).toBe("u123/generated/call-0-report.csv")
  })

  it("URL-decodes the path", () => {
    const url =
      "https://proj.supabase.co/storage/v1/object/sign/user-files/u123/generated/call-0-my%20file.csv?token=x"
    expect(parseStorageObjectPath(url)).toBe("u123/generated/call-0-my file.csv")
  })

  it("returns null for a data: URL", () => {
    expect(parseStorageObjectPath("data:text/csv;base64,AAAA")).toBeNull()
  })

  it("returns null for a non-Supabase https URL", () => {
    expect(parseStorageObjectPath("https://example.com/x.csv")).toBeNull()
  })

  it("returns null when the marker is present but the path is empty", () => {
    expect(
      parseStorageObjectPath(
        "https://proj.supabase.co/storage/v1/object/sign/user-files/?token=x",
      ),
    ).toBeNull()
  })

  it("returns null for an empty string", () => {
    expect(parseStorageObjectPath("")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/shared/storage-url.test.ts`
Expected: FAIL — cannot find module `./storage-url`.

- [ ] **Step 3: Implement**

Create `lib/shared/storage-url.ts`:

```typescript
/** The path segment that precedes the durable object path in a Supabase
 *  Storage *signed* URL for the `user-files` bucket (where generated
 *  images + files live). */
const SIGNED_MARKER = "/object/sign/user-files/"

/**
 * Extract the durable Supabase object path (e.g.
 * `<uid>/generated/<id>-report.csv`) from a generated-asset signed URL,
 * so it can be re-signed via the refresh endpoints. Returns null when the
 * URL isn't a recognizable `user-files` signed URL — a `data:` URL, a
 * non-Supabase URL, or an unexpected shape — in which case the caller
 * leaves the URL untouched (it either never expires or can't be repaired).
 *
 * Pure string logic, isomorphic. The returned path keeps its leading
 * `<uid>` segment, which the refresh route's owner-check requires.
 */
export function parseStorageObjectPath(url: string): string | null {
  if (!url || url.startsWith("data:")) return null
  const i = url.indexOf(SIGNED_MARKER)
  if (i === -1) return null
  const after = url.slice(i + SIGNED_MARKER.length)
  const q = after.indexOf("?")
  const raw = q === -1 ? after : after.slice(0, q)
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/shared/storage-url.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/shared/storage-url.ts lib/shared/storage-url.test.ts
git commit -m "feat(shared): parseStorageObjectPath from a signed URL"
```

---

## Task 2: Extract `triggerDownload` to a shared client util

**Files:**
- Create: `lib/client/download.ts`
- Modify: `components/skills/generated-files-list.tsx`

**Interfaces:**
- Produces: `triggerDownload(url: string, name: string): void`.

> No unit test: it's a `document`-touching DOM helper and the repo has no
> DOM test harness. Verify by `bun run check` + the existing
> `generated-files-list.test.ts` (which covers `humanSize` +
> `shouldRefreshFile`) staying green. This extraction removes a soon-to-be
> duplicated block (Task 4 needs the same helper).

- [ ] **Step 1: Create the shared util**

Create `lib/client/download.ts`:

```typescript
import "client-only"

/** Programmatic download via a transient anchor — used after an async
 *  re-sign, when the original click was prevented. */
export function triggerDownload(url: string, name: string): void {
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  // Detach on the next tick — some browsers (older WebKit/Safari) cancel a
  // download whose initiating anchor is removed in the same tick as click().
  a.click()
  setTimeout(() => a.remove(), 0)
}
```

- [ ] **Step 2: Rewire the chip to import it**

In `components/skills/generated-files-list.tsx`:
1. **Delete** the local `triggerDownload` function (the block from the
   `/** Programmatic download …` comment through its closing `}` — currently
   lines 28–39).
2. Add to the imports (next to the other `@/client` imports):

```typescript
import { triggerDownload } from "@/client/download"
```

The rest of the file (which calls `triggerDownload(fresh ?? file.url, file.name)`) is unchanged.

- [ ] **Step 3: Verify**

Run: `bun test components/skills/generated-files-list.test.ts && bun run check`
Expected: tests PASS; check clean.

- [ ] **Step 4: Commit**

```bash
git add lib/client/download.ts components/skills/generated-files-list.tsx
git commit -m "refactor(client): extract triggerDownload to a shared util"
```

---

## Task 3: `updateArtifactStoragePath` store mutation

**Files:**
- Modify: `lib/client/hooks/store/slices/artifacts.ts`
- Test: `lib/client/hooks/store/slices/artifacts.test.ts`

**Interfaces:**
- Produces: `updateArtifactStoragePath(artifactId: string, storagePath: string): void`.

- [ ] **Step 1: Write the failing test**

Create `lib/client/hooks/store/slices/artifacts.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"

import { useStore } from "@/client/hooks/use-store"

describe("updateArtifactStoragePath", () => {
  test("replaces the artifact's storagePath", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id,
      kind: "file",
      title: "a.csv",
      content: "",
      storagePath: "https://old",
    })
    useStore.getState().updateArtifactStoragePath(art.id, "https://fresh")
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.storagePath).toBe("https://fresh")
  })

  test("no-ops on an unknown artifact id", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id,
      kind: "file",
      title: "b.csv",
      content: "",
      storagePath: "https://keep",
    })
    useStore.getState().updateArtifactStoragePath("nope", "https://fresh")
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.storagePath).toBe("https://keep")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/client/hooks/store/slices/artifacts.test.ts`
Expected: FAIL — `updateArtifactStoragePath is not a function`.

- [ ] **Step 3: Implement**

In `lib/client/hooks/store/slices/artifacts.ts`, add to the slice
interface (next to `updateArtifactContent`):

```typescript
  /** Replace a single artifact's `storagePath` — used by the lazy
   *  signed-URL re-sign path so the fresh URL persists + syncs. No-op if
   *  the id is missing or the value is unchanged. */
  updateArtifactStoragePath: (artifactId: string, storagePath: string) => void
```

And the implementation (next to `updateArtifactContent`):

```typescript
  updateArtifactStoragePath: (artifactId, storagePath) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === artifactId && a.storagePath !== storagePath
          ? { ...a, storagePath }
          : a,
      ),
    })),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/client/hooks/store/slices/artifacts.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/client/hooks/store/slices/artifacts.ts lib/client/hooks/store/slices/artifacts.test.ts
git commit -m "feat(store): updateArtifactStoragePath mutation"
```

---

## Task 4: File artifact download re-sign

**Files:**
- Modify: `components/panels/artifacts-tab.tsx`

**Interfaces:**
- Consumes: `parseStorageObjectPath` (Task 1), `triggerDownload` (Task 2), `updateArtifactStoragePath` (Task 3), `apiClient.files.refreshUrl`.

> No render test (no harness). Verify by `bun run check`. Mirrors the
> chip's `FileChip` but updates the **artifact** store entry.

- [ ] **Step 1: Add imports**

In `components/panels/artifacts-tab.tsx`, ensure these are imported (add
any that are missing — check the existing import block first):

```typescript
import { useRef } from "react"
import { apiClient } from "@/client/api-client"
import { triggerDownload } from "@/client/download"
import { parseStorageObjectPath } from "@/shared/storage-url"
import type { Artifact } from "@/shared/types"
```

(`useStore` is already imported in this file.)

- [ ] **Step 2: Add the `ArtifactFileDownload` component**

Add near the other module-level components/helpers in the file:

```typescript
function ArtifactFileDownload({ artifact }: { artifact: Artifact }) {
  const updateStoragePath = useStore((s) => s.updateArtifactStoragePath)
  // Guard a concurrent in-flight click; resets after each attempt.
  const inFlight = useRef(false)
  const href = artifact.storagePath ?? artifact.content

  const onClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    const path = parseStorageObjectPath(href)
    if (!path) return // data: / unrecognized → native <a download>
    e.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    try {
      const fresh = await apiClient.files.refreshUrl(path)
      if (fresh) updateStoragePath(artifact.id, fresh)
      triggerDownload(fresh ?? href, artifact.title)
    } finally {
      inFlight.current = false
    }
  }

  return (
    <a
      href={href}
      download={artifact.title}
      onClick={onClick}
      className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm hover:bg-[var(--accent)]"
    >
      <Download className="size-4" />
      <span className="font-medium">{artifact.title}</span>
    </a>
  )
}
```

- [ ] **Step 3: Use it in the `file` branch**

Replace the `<a …>…</a>` inside the `artifact?.kind === "file"` branch
with `<ArtifactFileDownload artifact={artifact} />`. The branch becomes:

```tsx
          ) : artifact?.kind === "file" ? (
            <div className="flex flex-col items-center gap-3 p-6">
              <ArtifactFileDownload artifact={artifact} />
              <p className="text-xs text-[var(--muted-foreground)]">
                Generated by the code interpreter
              </p>
            </div>
```

- [ ] **Step 4: Verify**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/panels/artifacts-tab.tsx
git commit -m "feat(artifacts): re-sign file-artifact download URL on click"
```

---

## Task 5: Image artifact preview re-sign

**Files:**
- Modify: `components/panels/artifacts-tab.tsx`

**Interfaces:**
- Consumes: `parseStorageObjectPath` (Task 1), `updateArtifactStoragePath` (Task 3), `apiClient.images.refreshUrl`.

> No render test. Verify by `bun run check`. Mirrors the `<img onError>`
> one-shot in `generated-images-gallery.tsx`.

- [ ] **Step 1: Add the `ArtifactImage` component**

In `components/panels/artifacts-tab.tsx`, add near `ArtifactFileDownload`
(the imports it needs — `useRef`, `apiClient`, `parseStorageObjectPath`,
`Artifact`, `useStore` — are already present from Task 4):

```typescript
function ArtifactImage({ artifact }: { artifact: Artifact }) {
  const updateStoragePath = useStore((s) => s.updateArtifactStoragePath)
  // One attempt per mount — a path that refuses to re-sign must not loop.
  const refreshed = useRef(false)
  const src = artifact.storagePath ?? artifact.content

  const onError = async () => {
    if (refreshed.current) return
    refreshed.current = true
    const path = parseStorageObjectPath(src)
    if (!path) return
    const fresh = await apiClient.images.refreshUrl(path)
    if (fresh) updateStoragePath(artifact.id, fresh)
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- data: URLs + signed Supabase URLs with unknown dimensions; next/image doesn't fit.
    <img
      src={src}
      alt={artifact.title}
      onError={onError}
      className="max-w-full max-h-[50vh] rounded-md object-contain"
    />
  )
}
```

- [ ] **Step 2: Use it in the `image` branch**

Replace the existing `<img … />` inside the `artifact?.kind === "image"`
branch with `<ArtifactImage artifact={artifact} />` (keep the surrounding
`<div>` and the caption `<p>`). The branch becomes:

```tsx
          ) : artifact?.kind === "image" ? (
            <div className="flex flex-col items-center p-4">
              <ArtifactImage artifact={artifact} />
              {artifact.content && (
                <p className="mt-3 text-xs text-[var(--muted-foreground)] text-center max-w-md">
                  {artifact.content}
                </p>
              )}
            </div>
```

(The `eslint-disable` comment moves into `ArtifactImage`; remove the old
one left behind at the original `<img>` site.)

- [ ] **Step 3: Verify**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/panels/artifacts-tab.tsx
git commit -m "feat(artifacts): re-sign image-artifact preview URL on error"
```

---

## Task 6: Manual-runbook step

**Files:**
- Modify: `docs/SMOKE-TEST-generated-files.md`

- [ ] **Step 1: Append an artifact-refresh step**

In `docs/SMOKE-TEST-generated-files.md`, at the end of **Test B**, add:

```markdown
5. [ ] **Artifact download/preview self-heals (file + image).** Open the
   Artifacts tab, pick a generated **file** artifact, break its stored
   `storagePath` in the persisted store (append junk to the signed
   URL's token; keep the `/object/sign/user-files/<path>` part intact),
   reload, then click its download row → you see `POST
   /api/files/refresh-url → 200` and the file downloads. Repeat for an
   **image** artifact: break its `storagePath`, reload → the preview
   `<img>` errors then re-fetches via `POST /api/images/refresh-url →
   200` and renders. A `data:`/local artifact (no signed URL) shows no
   refresh request — it just downloads/renders as-is.
```

- [ ] **Step 2: Commit**

```bash
git add docs/SMOKE-TEST-generated-files.md
git commit -m "docs: artifact-refresh step in the smoke-test runbook"
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

- [ ] **Manual:** follow the new step in `docs/SMOKE-TEST-generated-files.md`.

---

## Self-Review

**Spec coverage:**
- `parseStorageObjectPath` pure helper → Task 1. ✓
- `updateArtifactStoragePath` mutation → Task 3. ✓
- File artifact branch re-sign on click → Task 4. ✓
- Image artifact branch re-sign on error → Task 5. ✓
- Reuse existing refresh endpoints, no new route/schema/migration → Tasks 4/5 call `apiClient.{files,images}.refreshUrl`; nothing else added. ✓
- Graceful fallback (null path → behave as today) → Task 1 returns null + Tasks 4/5 early-return. ✓
- Fixes existing artifacts (derive from stored URL) → inherent to Task 1's approach. ✓
- Manual runbook step → Task 6. ✓
- Shared `triggerDownload` (avoid duplication) → Task 2. ✓

**Type consistency:** `parseStorageObjectPath(url): string | null` (Task 1) is consumed identically in Tasks 4/5. `triggerDownload(url, name)` (Task 2) matches the call in Task 4 and the existing chip call. `updateArtifactStoragePath(artifactId, storagePath)` (Task 3) matches the calls in Tasks 4/5. `apiClient.files.refreshUrl` / `apiClient.images.refreshUrl` are the existing methods (string → Promise<string|null>). `Artifact` prop type is consistent across Tasks 4/5.

**Placeholder scan:** none — every code step carries complete code.
