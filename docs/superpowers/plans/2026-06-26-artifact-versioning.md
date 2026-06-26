# Artifact Version History + Diffs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a capped history of an artifact's prior content, let the user view a prior-version→current line diff in the artifact dialog, and restore a prior version non-destructively.

**Architecture:** `updateArtifactContent` (the single content mutator) snapshots the old content into a capped `Artifact.versions` array. Two pure `lib/shared` modules carry the logic — a version-list capper and a dependency-free LCS line-diff. A new `versions` JSONB column + sync wiring persists it. The artifact dialog gains a History panel (version list → diff view → Restore).

**Tech Stack:** React 19, TypeScript, Zustand, bun:test, Supabase (Postgres), no new npm dependency.

## Global Constraints

- **No new dependency** — diffing uses a pure LCS line-diff helper (the lockfile's `diff-match-patch-ts` is transitive-only; do NOT import it).
- **No `STORE_VERSION` bump** — `versions` is an optional sub-field inside the already-persisted `artifacts` key; the frozen persisted key-set (`store/persist.test.ts`) is unchanged. Only a Supabase migration + sync wiring are needed.
- Retention cap: `MAX_ARTIFACT_VERSIONS = 10` (oldest dropped).
- Capture only on a real change (`content !== a.content`) → no spurious versions.
- Versioning applies to text kinds (`code|markdown|json|table|other`); `image`/`file` never call `updateArtifactContent` with real content and the History control is hidden for them.
- `lib/shared/*` = pure, no fence; `lib/client/*` = `import "client-only"`; components = `"use client"`.
- Migration file is **`supabase/migrations/0029_artifact_versions.sql`** (latest existing is `0028_subagents.sql`).
- Tests: `bun test <path>`; new `*.test.ts` under `./lib` or `./components`. Live-store tests drive `useStore.getState()`.
- Run `bun run check` before each commit; must pass. Commit messages: **no `Co-Authored-By` trailer**.
- The generated `Database` type (`lib/shared/supabase/types.ts`) is hand-edited (no live regen), mirroring the `messages.generated_files` precedent.

---

## File Structure

- `lib/shared/types.ts` — `ArtifactVersion` type + `Artifact.versions`. (Task 1)
- `lib/shared/artifacts/versioning.ts` *(new)* — `MAX_ARTIFACT_VERSIONS` + `pushArtifactVersion`. (Task 1)
- `lib/shared/artifacts/diff.ts` *(new)* — `diffLines` + `prettyForDiff` + `DiffSegment`. (Task 2)
- `lib/client/hooks/store/slices/artifacts.ts` — capture in `updateArtifactContent` + `restoreArtifactVersion`. (Task 3)
- `supabase/migrations/0029_artifact_versions.sql` *(new)*, `lib/shared/supabase/types.ts`, `lib/client/sync/reconcile.ts`, `lib/client/sync/handlers.ts` — the `versions` column end-to-end. (Task 4)
- `components/panels/artifact-diff-view.tsx` *(new)*, `components/panels/artifact-history-panel.tsx` *(new)*, `components/panels/artifacts-tab.tsx` — the History UI. (Task 5)
- `docs/SMOKE-TEST-artifact-versioning.md` *(new)* — runbook. (Task 6)

Tests live beside their module (`versioning.test.ts`, `diff.test.ts`, `artifacts.test.ts` already exists from a prior session — append to it).

---

## Task 1: `ArtifactVersion` type + version-capper helper

**Files:**
- Modify: `lib/shared/types.ts`
- Create: `lib/shared/artifacts/versioning.ts`
- Test: `lib/shared/artifacts/versioning.test.ts`

**Interfaces:**
- Produces: `ArtifactVersion { id: string; content: string; createdAt: Date }`; `Artifact.versions?: ArtifactVersion[]`; `MAX_ARTIFACT_VERSIONS = 10`; `pushArtifactVersion(versions, newVersion, cap?) => ArtifactVersion[]`.

- [ ] **Step 1: Add the type**

In `lib/shared/types.ts`, immediately before the `Artifact` interface, add:

```typescript
export interface ArtifactVersion {
  id: string
  /** A PRIOR snapshot of the artifact's content. */
  content: string
  createdAt: Date
}
```

And inside the `Artifact` interface, after the `createdAt` field, add:

```typescript
  /** Prior content snapshots, oldest→newest, capped at
   *  MAX_ARTIFACT_VERSIONS. `content` is always current; `versions` holds
   *  what it was before each edit. Absent = no history yet. */
  versions?: ArtifactVersion[]
```

- [ ] **Step 2: Write the failing test**

Create `lib/shared/artifacts/versioning.test.ts`:

```typescript
import { describe, expect, it } from "bun:test"

import type { ArtifactVersion } from "@/shared/types"
import { MAX_ARTIFACT_VERSIONS, pushArtifactVersion } from "./versioning"

const v = (id: string): ArtifactVersion => ({
  id,
  content: id,
  createdAt: new Date("2026-01-01T00:00:00Z"),
})

describe("pushArtifactVersion", () => {
  it("appends to the end (oldest→newest)", () => {
    expect(pushArtifactVersion([v("a")], v("b")).map((x) => x.id)).toEqual(["a", "b"])
  })
  it("treats undefined as an empty list", () => {
    expect(pushArtifactVersion(undefined, v("a")).map((x) => x.id)).toEqual(["a"])
  })
  it("caps at the limit, dropping the oldest", () => {
    const seed = Array.from({ length: MAX_ARTIFACT_VERSIONS }, (_, i) => v(`v${i}`))
    const out = pushArtifactVersion(seed, v("new"))
    expect(out).toHaveLength(MAX_ARTIFACT_VERSIONS)
    expect(out[0].id).toBe("v1") // v0 dropped
    expect(out[out.length - 1].id).toBe("new")
  })
  it("respects an explicit cap arg", () => {
    const out = pushArtifactVersion([v("a"), v("b")], v("c"), 2)
    expect(out.map((x) => x.id)).toEqual(["b", "c"])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test lib/shared/artifacts/versioning.test.ts`
Expected: FAIL — cannot find module `./versioning`.

- [ ] **Step 4: Implement**

Create `lib/shared/artifacts/versioning.ts`:

```typescript
import type { ArtifactVersion } from "@/shared/types"

/** Max prior versions kept per artifact (oldest dropped past this). */
export const MAX_ARTIFACT_VERSIONS = 10

/** Append `newVersion` to `versions` and cap to the last `cap` entries
 *  (drops the oldest). Pure — the caller builds `newVersion` (with its
 *  uuid + timestamp) so this stays deterministic. */
export function pushArtifactVersion(
  versions: ArtifactVersion[] | undefined,
  newVersion: ArtifactVersion,
  cap: number = MAX_ARTIFACT_VERSIONS,
): ArtifactVersion[] {
  const next = [...(versions ?? []), newVersion]
  return next.length > cap ? next.slice(next.length - cap) : next
}
```

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `bun test lib/shared/artifacts/versioning.test.ts && bun run typecheck`
Expected: PASS (4 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add lib/shared/types.ts lib/shared/artifacts/versioning.ts lib/shared/artifacts/versioning.test.ts
git commit -m "feat(artifacts): ArtifactVersion type + pushArtifactVersion capper"
```

---

## Task 2: Pure line-diff + pretty-print helpers

**Files:**
- Create: `lib/shared/artifacts/diff.ts`
- Test: `lib/shared/artifacts/diff.test.ts`

**Interfaces:**
- Produces: `DiffOp = "equal" | "insert" | "delete"`; `DiffSegment { op: DiffOp; text: string }`; `diffLines(oldText, newText) => DiffSegment[]`; `prettyForDiff(content, kind) => string`.

- [ ] **Step 1: Write the failing test**

Create `lib/shared/artifacts/diff.test.ts`:

```typescript
import { describe, expect, it } from "bun:test"

import { diffLines, prettyForDiff } from "./diff"

describe("diffLines", () => {
  it("returns one equal segment for identical text", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([{ op: "equal", text: "a\nb" }])
  })
  it("detects an inserted line", () => {
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([
      { op: "equal", text: "a" },
      { op: "insert", text: "b" },
      { op: "equal", text: "c" },
    ])
  })
  it("detects a deleted line", () => {
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([
      { op: "equal", text: "a" },
      { op: "delete", text: "b" },
      { op: "equal", text: "c" },
    ])
  })
  it("represents a replacement as delete + insert", () => {
    expect(diffLines("a\nx\nc", "a\ny\nc")).toEqual([
      { op: "equal", text: "a" },
      { op: "delete", text: "x" },
      { op: "insert", text: "y" },
      { op: "equal", text: "c" },
    ])
  })
  it("handles an empty old side (all insert)", () => {
    expect(diffLines("", "a")).toEqual([
      { op: "delete", text: "" },
      { op: "insert", text: "a" },
    ])
  })
})

describe("prettyForDiff", () => {
  it("pretty-prints json/table content", () => {
    expect(prettyForDiff('{"a":1}', "json")).toBe('{\n  "a": 1\n}')
    expect(prettyForDiff('{"a":1}', "table")).toBe('{\n  "a": 1\n}')
  })
  it("returns non-json kinds unchanged", () => {
    expect(prettyForDiff("# hi", "markdown")).toBe("# hi")
  })
  it("returns the raw string when json is invalid (no throw)", () => {
    expect(prettyForDiff("{not json", "json")).toBe("{not json")
  })
})
```

> Note the empty-old case: `"".split("\n")` is `[""]` and `"a"` is `["a"]`,
> which share no common line, so the diff is `delete "" + insert "a"`. The
> test pins that exact behavior.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/shared/artifacts/diff.test.ts`
Expected: FAIL — cannot find module `./diff`.

- [ ] **Step 3: Implement**

Create `lib/shared/artifacts/diff.ts`:

```typescript
import type { ArtifactKind } from "@/shared/types"

export type DiffOp = "equal" | "insert" | "delete"
export interface DiffSegment {
  op: DiffOp
  text: string
}

/** Line-level LCS diff of two text blobs. Adjacent same-op lines are
 *  coalesced into one segment (joined by "\n"). Pure + deterministic. */
export function diffLines(oldText: string, newText: string): DiffSegment[] {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const segs: DiffSegment[] = []
  const push = (op: DiffOp, text: string) => {
    const last = segs[segs.length - 1]
    if (last && last.op === op) last.text += `\n${text}`
    else segs.push({ op, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("equal", a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("delete", a[i])
      i++
    } else {
      push("insert", b[j])
      j++
    }
  }
  while (i < n) {
    push("delete", a[i])
    i++
  }
  while (j < m) {
    push("insert", b[j])
    j++
  }
  return segs
}

/** Prepare content for a line diff: pretty-print json/table so the diff
 *  is line-oriented; everything else passes through. Never throws. */
export function prettyForDiff(content: string, kind: ArtifactKind): string {
  if (kind === "json" || kind === "table") {
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      return content
    }
  }
  return content
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/shared/artifacts/diff.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/shared/artifacts/diff.ts lib/shared/artifacts/diff.test.ts
git commit -m "feat(artifacts): pure line-diff + pretty-print helpers"
```

---

## Task 3: Capture in `updateArtifactContent` + `restoreArtifactVersion`

**Files:**
- Modify: `lib/client/hooks/store/slices/artifacts.ts`
- Test: `lib/client/hooks/store/slices/artifacts.test.ts` (exists — append)

**Interfaces:**
- Consumes: `pushArtifactVersion` (Task 1), `ArtifactVersion`.
- Produces: `updateArtifactContent` now captures a version; `restoreArtifactVersion(artifactId: string, versionId: string): void`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/client/hooks/store/slices/artifacts.test.ts`:

```typescript
describe("artifact versioning", () => {
  test("updateArtifactContent captures the prior content as a version", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id, kind: "markdown", title: "doc", content: "v1",
    })
    useStore.getState().updateArtifactContent(art.id, "v2")
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.content).toBe("v2")
    expect(got?.versions?.map((v) => v.content)).toEqual(["v1"])
  })

  test("no version captured when content is unchanged", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id, kind: "markdown", title: "doc", content: "same",
    })
    useStore.getState().updateArtifactContent(art.id, "same")
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.versions ?? []).toEqual([])
  })

  test("restoreArtifactVersion swaps content and captures the prior current", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id, kind: "markdown", title: "doc", content: "v1",
    })
    useStore.getState().updateArtifactContent(art.id, "v2") // versions: [v1], content v2
    const v1Id = useStore.getState().artifacts.find((a) => a.id === art.id)!.versions![0].id
    useStore.getState().restoreArtifactVersion(art.id, v1Id)
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.content).toBe("v1")
    // restoring captured the prior current ("v2") as a new version
    expect(got?.versions?.map((v) => v.content)).toEqual(["v1", "v2"])
  })

  test("restoreArtifactVersion no-ops on an unknown version id", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id, kind: "markdown", title: "doc", content: "v1",
    })
    useStore.getState().restoreArtifactVersion(art.id, "nope")
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.content).toBe("v1")
  })
})
```

(The test file already imports `useStore`; reuse it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/client/hooks/store/slices/artifacts.test.ts`
Expected: FAIL — the version isn't captured / `restoreArtifactVersion` is not a function.

- [ ] **Step 3: Implement**

In `lib/client/hooks/store/slices/artifacts.ts`:

Add imports near the top (the file already imports `uuid`):

```typescript
import type { ArtifactVersion } from "@/shared/types"
import { pushArtifactVersion } from "@/shared/artifacts/versioning"
```

Add to the `ArtifactsSlice` interface (next to `updateArtifactContent`):

```typescript
  restoreArtifactVersion: (artifactId: string, versionId: string) => void
```

Replace the existing `updateArtifactContent` implementation with:

```typescript
  updateArtifactContent: (artifactId, content) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) => {
        if (a.id !== artifactId || a.content === content) return a
        const version: ArtifactVersion = {
          id: uuid(),
          content: a.content, // the PRIOR content
          createdAt: new Date(),
        }
        return { ...a, content, versions: pushArtifactVersion(a.versions, version) }
      }),
    })),
```

Add the restore action (next to `updateArtifactContent`):

```typescript
  restoreArtifactVersion: (artifactId, versionId) => {
    const a = get().artifacts.find((x) => x.id === artifactId)
    const v = a?.versions?.find((x) => x.id === versionId)
    if (!a || !v) return
    // Route through updateArtifactContent so the current content is itself
    // captured as a version — restore is non-destructive.
    get().updateArtifactContent(artifactId, v.content)
  },
```

(Confirm `get` is available in this slice factory — the slices use the
`SliceCreator` signature `(set, get) => ({...})`; `get()` is already used
elsewhere in this file, e.g. `createArtifact`.)

- [ ] **Step 4: Run test to verify it passes + check**

Run: `bun test lib/client/hooks/store/slices/artifacts.test.ts && bun run check`
Expected: PASS; check clean.

- [ ] **Step 5: Commit**

```bash
git add lib/client/hooks/store/slices/artifacts.ts lib/client/hooks/store/slices/artifacts.test.ts
git commit -m "feat(artifacts): capture versions on edit + restoreArtifactVersion"
```

---

## Task 4: Persist `versions` (migration + Database type + sync)

**Files:**
- Create: `supabase/migrations/0029_artifact_versions.sql`
- Modify: `lib/shared/supabase/types.ts`, `lib/client/sync/reconcile.ts`, `lib/client/sync/handlers.ts`

**Interfaces:**
- Consumes: `ArtifactVersion` (Task 1).
- Produces: `artifacts.versions` round-trips through Supabase sync.

> No unit test for the SQL; the sync TS is verified by `bun run check` +
> the migration round-trip is in the manual runbook. Mirror the
> `messages.generated_files` precedent.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0029_artifact_versions.sql`:

```sql
-- Artifact version history (capped, inline).
--
-- `updateArtifactContent` now snapshots the prior content into
-- `Artifact.versions` (capped at MAX_ARTIFACT_VERSIONS). A single nullable
-- JSONB column carries the `ArtifactVersion[]` shape from
-- `lib/shared/types.ts`. Nullable + default NULL (not '[]') so pre-existing
-- rows stay absent until first edited — the sync diff only writes a value
-- when the artifact actually has versions. Mirrors
-- `0018_message_generated_files.sql`.
--
-- Idempotent: column added only if missing.

alter table artifacts
  add column if not exists versions jsonb;
```

- [ ] **Step 2: Add the column to the generated Database type**

In `lib/shared/supabase/types.ts`, in the `artifacts` table block, add a
`versions` entry next to `storage_path` in each of Row / Insert / Update:

- Row (after `storage_path: string | null`):

```typescript
          versions: Json | null
```

- Insert (after `storage_path?: string | null`):

```typescript
          versions?: Json | null
```

- Update (after `storage_path?: string | null`):

```typescript
          versions?: Json | null
```

(`Json` is already imported/used in this file.)

- [ ] **Step 3: Parse `versions` on read (reconcile.ts)**

In `lib/client/sync/reconcile.ts`, add a defensive parser near the other
boundary parsers (e.g. beside `parseGeneratedImages`):

```typescript
function parseArtifactVersions(value: Json | null | undefined): ArtifactVersion[] {
  if (!Array.isArray(value)) return []
  const out: ArtifactVersion[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue
    const v = raw as Record<string, unknown>
    if (typeof v.id !== "string" || typeof v.content !== "string") continue
    const createdAt =
      typeof v.createdAt === "string" || typeof v.createdAt === "number"
        ? new Date(v.createdAt)
        : new Date()
    out.push({ id: v.id, content: v.content, createdAt })
  }
  return out
}
```

Ensure `ArtifactVersion` is imported from `@/shared/types` in this file
(alongside `Artifact`). Then, in the artifact `.map((a) => ({ … }))` block
(the one that sets `storagePath: a.storage_path`), add:

```typescript
      versions: parseArtifactVersions(a.versions),
```

And in the bulk-upload artifact row builder (the `.map((a) => ({ … }))`
that sets `storage_path: a.storagePath`), add:

```typescript
          versions:
            a.versions && a.versions.length > 0
              ? (a.versions as unknown as Json)
              : null,
```

- [ ] **Step 4: Diff `versions` on write (handlers.ts)**

In `lib/client/sync/handlers.ts`, in `diffArtifacts`' upsert `row`
(beside `storage_path: a.storagePath`), add:

```typescript
          versions:
            a.versions && a.versions.length > 0
              ? (a.versions as unknown as Json)
              : null,
```

And in `artifactEquals`, add a versions comparison so a version change
triggers an upsert (add before the final `)`):

```typescript
    versionsEqual(a.versions, b.versions) &&
```

with this helper added to the file:

```typescript
function versionsEqual(
  a: ArtifactVersion[] | undefined,
  b: ArtifactVersion[] | undefined,
): boolean {
  const x = a ?? []
  const y = b ?? []
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) {
    if (x[i].id !== y[i].id || x[i].content !== y[i].content) return false
  }
  return true
}
```

Ensure `ArtifactVersion` + `Json` are imported in `handlers.ts` (it
already imports `Artifact` and `Json`-typed rows; add `ArtifactVersion`).

- [ ] **Step 5: Verify**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0029_artifact_versions.sql lib/shared/supabase/types.ts lib/client/sync/reconcile.ts lib/client/sync/handlers.ts
git commit -m "feat(sync): persist + round-trip artifact versions"
```

---

## Task 5: History UI (diff view + history panel + dialog wiring)

**Files:**
- Create: `components/panels/artifact-diff-view.tsx`
- Create: `components/panels/artifact-history-panel.tsx`
- Modify: `components/panels/artifacts-tab.tsx`

**Interfaces:**
- Consumes: `diffLines` + `prettyForDiff` (Task 2), `restoreArtifactVersion` (Task 3), the `Artifact`/`ArtifactVersion` types.

> Not render-tested (no `@testing-library` in repo); verified by
> `bun run check` + the runbook. The diff/segment logic is unit-tested in
> Task 2.

- [ ] **Step 1: Create the diff view**

Create `components/panels/artifact-diff-view.tsx`:

```typescript
"use client"

import type { DiffSegment } from "@/shared/artifacts/diff"
import { cn } from "@/shared/utils"

/** Renders pre-computed line-diff segments as a git-style block:
 *  green = inserted (in current), red = deleted (in the older version). */
export function ArtifactDiffView({ segments }: { segments: DiffSegment[] }) {
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap break-words m-0">
      {segments.map((seg, i) => (
        <span
          key={i}
          className={cn(
            "block",
            seg.op === "insert" && "bg-green-500/15 text-green-700 dark:text-green-300",
            seg.op === "delete" && "bg-red-500/15 text-red-700 dark:text-red-300 line-through",
            seg.op === "equal" && "text-[var(--muted-foreground)]",
          )}
        >
          {seg.op === "insert" ? "+ " : seg.op === "delete" ? "- " : "  "}
          {seg.text}
        </span>
      ))}
    </pre>
  )
}
```

- [ ] **Step 2: Create the history panel**

Create `components/panels/artifact-history-panel.tsx`:

```typescript
"use client"

import { useState } from "react"
import { RotateCcw, X } from "lucide-react"

import type { Artifact } from "@/shared/types"
import { diffLines, prettyForDiff } from "@/shared/artifacts/diff"
import { useStore } from "@/client/hooks/use-store"
import { cn } from "@/shared/utils"
import { Button } from "@/components/ui/button"
import { ArtifactDiffView } from "@/components/panels/artifact-diff-view"

/** Version history for one artifact: list of prior snapshots (newest
 *  first), a diff of the selected version → current, and Restore. */
export function ArtifactHistoryPanel({
  artifact,
  onClose,
}: {
  artifact: Artifact
  onClose: () => void
}) {
  const restoreArtifactVersion = useStore((s) => s.restoreArtifactVersion)
  const versions = artifact.versions ?? []
  // Newest first; default-select the most recent prior version.
  const ordered = [...versions].reverse()
  const [selectedId, setSelectedId] = useState<string | null>(ordered[0]?.id ?? null)
  const selected = ordered.find((v) => v.id === selectedId) ?? ordered[0] ?? null

  const segments = selected
    ? diffLines(
        prettyForDiff(selected.content, artifact.kind),
        prettyForDiff(artifact.content, artifact.kind),
      )
    : []

  return (
    <div className="flex h-full min-h-0">
      <div className="w-48 shrink-0 border-r border-[var(--border)] overflow-y-auto">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-xs font-medium text-[var(--muted-foreground)]">History</span>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose} aria-label="Close history">
            <X size={12} />
          </Button>
        </div>
        <ul className="m-0 p-0 list-none">
          <li className="px-2 py-1.5 text-xs text-[var(--muted-foreground)] italic">Current</li>
          {ordered.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => setSelectedId(v.id)}
                className={cn(
                  "w-full text-left px-2 py-1.5 text-xs hover:bg-[var(--accent)]",
                  v.id === selectedId && "bg-[var(--primary)]/10 text-[var(--primary)]",
                )}
              >
                {new Date(v.createdAt).toLocaleString()}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-end px-2 py-1.5 border-b border-[var(--border)]">
          <Button
            size="sm"
            variant="outline"
            disabled={!selected}
            onClick={() => selected && restoreArtifactVersion(artifact.id, selected.id)}
            className="gap-1.5"
          >
            <RotateCcw size={12} />
            Restore this version
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {selected ? (
            <ArtifactDiffView segments={segments} />
          ) : (
            <p className="text-xs text-[var(--muted-foreground)]">No prior versions.</p>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wire the History toggle into the artifact dialog**

In `components/panels/artifacts-tab.tsx` (the `ArtifactPreviewDialog`
component that renders the detail view):

1. Add imports:

```typescript
import { History } from "lucide-react"
import { ArtifactHistoryPanel } from "@/components/panels/artifact-history-panel"
```

2. Add state in the dialog component (near the other `useState` calls):

```typescript
  const [historyOpen, setHistoryOpen] = useState(false)
```

3. Define a gate (after `artifact` is in scope) — text kinds with versions:

```typescript
  const canShowHistory =
    !!artifact &&
    (artifact.versions?.length ?? 0) > 0 &&
    artifact.kind !== "image" &&
    artifact.kind !== "file"
```

4. Add a History button in the dialog header actions (next to the rename /
   kind badge — match the existing header button style; read the header to
   place it):

```tsx
{canShowHistory && (
  <Button
    size="icon"
    variant="ghost"
    className="h-6 w-6 text-[var(--muted-foreground)]"
    onClick={() => setHistoryOpen((v) => !v)}
    aria-label="Version history"
    title="Version history"
  >
    <History size={12} />
  </Button>
)}
```

5. In the content container (the `<div className="flex-1 min-h-0 overflow-auto …">`
   that holds the kind ternary), render the history panel **instead of** the
   ternary when `historyOpen && canShowHistory`:

```tsx
{historyOpen && canShowHistory ? (
  <ArtifactHistoryPanel artifact={artifact} onClose={() => setHistoryOpen(false)} />
) : (
  /* …the existing kind ternary stays here, unchanged… */
)}
```

   (When the artifact has no history or is image/file, `canShowHistory`
   is false so the button is hidden and the ternary always renders.)

- [ ] **Step 4: Verify**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/panels/artifact-diff-view.tsx components/panels/artifact-history-panel.tsx components/panels/artifacts-tab.tsx
git commit -m "feat(artifacts): version-history panel + diff view in the artifact dialog"
```

---

## Task 6: Manual-test runbook

**Files:**
- Create: `docs/SMOKE-TEST-artifact-versioning.md`

- [ ] **Step 1: Write the runbook**

Create `docs/SMOKE-TEST-artifact-versioning.md`:

```markdown
# Smoke test — artifact version history + diffs

Manual checks (need a running app: `bun dev`). The live editable artifact
today is a **citation table** (table-kind), so use one.

1. [ ] **Versions accrue on edit.** Open/create a chat that produces a
   citation-table artifact. Open it in the Artifacts tab, edit a cell
   (changes `content`). Edit a second cell. A **History** button (clock
   icon) appears in the dialog header.
2. [ ] **History + diff.** Click History → the panel lists prior versions
   (newest first) + "Current". Select a prior version → the diff shows the
   pretty-printed JSON line diff (red = removed, green = added) between that
   version and current.
3. [ ] **Restore is non-destructive.** Click "Restore this version" → the
   artifact content reverts to that version, AND a new version (the
   pre-restore content) appears in the list — nothing is lost.
4. [ ] **Cap.** Make 11+ edits → the history holds at most 10 prior
   versions (oldest dropped).
5. [ ] **No history for binary kinds.** Open an `image`/`file` artifact →
   no History button.
6. [ ] **Persistence (Supabase mode).** Reload → versions survive; with
   Supabase configured they sync across devices (the new `versions`
   column round-trips).
```

- [ ] **Step 2: Commit**

```bash
git add docs/SMOKE-TEST-artifact-versioning.md
git commit -m "docs: smoke-test runbook for artifact versioning"
```

---

## Final verification (after all tasks)

- [ ] `bun run check && bun run test` — typecheck + lint clean; all tests pass (the intentional `postgres unreachable` throw at `route.handler.test.ts:240` is NOT a failure).
- [ ] Manual: follow `docs/SMOKE-TEST-artifact-versioning.md`.

---

## Self-Review

**Spec coverage:**
- `ArtifactVersion` + `Artifact.versions` + cap + `pushArtifactVersion` → Task 1. ✓
- Capture in `updateArtifactContent` (skip no-op) + `restoreArtifactVersion` (non-destructive) → Task 3. ✓
- Pure `diffLines` + `prettyForDiff` (json/table pretty-print, no new dep) → Task 2. ✓
- Migration 0029 + Database type + reconcile parse/bulk-upload + handlers diff/equals → Task 4. ✓
- History panel + diff view + dialog gate (text kinds, versions>0) → Task 5. ✓
- No `STORE_VERSION` bump (optional sub-field) → none added. ✓
- Runbook → Task 6. ✓

**Type consistency:** `ArtifactVersion {id,content,createdAt}` (Task 1) is used identically in the slice (Task 3), reconcile/handlers parsers (Task 4), and the panel (Task 5). `pushArtifactVersion(versions, newVersion, cap?)` (Task 1) is called in Task 3. `diffLines(old,new) → DiffSegment[]` + `prettyForDiff(content, kind)` (Task 2) are consumed by the panel (Task 5) and `ArtifactDiffView` takes `DiffSegment[]` (Task 5). `restoreArtifactVersion(artifactId, versionId)` (Task 3) is called from the panel (Task 5).

**Placeholder scan:** none — every code step carries complete code (the only prose-only insertion is "the existing kind ternary stays here", which is a deliberate *don't-touch* marker, not a missing implementation).
