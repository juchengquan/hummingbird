# Subagent Orchestration PR-3b — Child-Run Drill-In — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a spawned-subagent pill in the task strip opens a right-side Sheet showing that child task's live run (its own read-only `TaskStrip`).

**Architecture:** Mirror the existing viewer pattern (`components/text-viewer/`): a zustand store holds the open `target` (`{childTaskId}`); a `ChildRunModalHost` renders a `Sheet` whose `ChildRunView` calls a standalone `useTaskRun().resume(childTaskId, 0)` and renders `<TaskStrip>` with no callbacks (read-only). `SubagentGroup` pills become buttons that call `openChildRunViewer(...)`.

**Tech Stack:** React, zustand, Next.js, Bun test (store only — no React component-test harness in the repo).

**Spec:** [`docs/superpowers/specs/2026-06-20-subagent-orchestration-pr3b-design.md`](../specs/2026-06-20-subagent-orchestration-pr3b-design.md)

**Conventions:** repo gate `bun run check` (typecheck + lint + test). `"use client"` at the top of client components. Deps pre-installed in this worktree by the controller.

**Exact shapes to mirror (read these):**
- `components/text-viewer/types.ts` — the zustand store pattern (`target`/`open`/`close`).
- `components/text-viewer/text-viewer.tsx:34-39` — the `…Host` (reads store, returns null if no target) + `:161-163` the Sheet render: `<Sheet open={true} onOpenChange={(o) => { if (!o) onClose() }}><SheetContent side="right">…`; Sheet imports from `@/components/ui/sheet`.
- `lib/client/hooks/use-task-run.ts:40-57` — `useTaskRun()` returns `{ view, runId, isRunning, error, resume(runId, cursor?), … }`.
- `components/agent/task-strip.tsx:445-468` — current `SubagentGroup` (the `<li>` rows to make clickable); `TaskStripProps` callbacks are all optional.
- `app/dashboard/page.tsx:128-131` — where the viewer hosts are mounted.

---

### Task 1: Child-run viewer store

**Files:**
- Create: `lib/client/agent/child-run-viewer/types.ts`
- Test: `lib/client/agent/child-run-viewer/types.test.ts`

- [ ] **Step 1: Write the failing test** — `lib/client/agent/child-run-viewer/types.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test"

import { openChildRunViewer, useChildRunViewer } from "./types"

afterEach(() => useChildRunViewer.getState().close())

describe("useChildRunViewer", () => {
  test("open sets the target", () => {
    useChildRunViewer.getState().open({ childTaskId: "c1" })
    expect(useChildRunViewer.getState().target).toEqual({ childTaskId: "c1" })
  })
  test("close clears the target", () => {
    useChildRunViewer.getState().open({ childTaskId: "c1" })
    useChildRunViewer.getState().close()
    expect(useChildRunViewer.getState().target).toBeNull()
  })
  test("openChildRunViewer helper calls open", () => {
    openChildRunViewer({ childTaskId: "c2" })
    expect(useChildRunViewer.getState().target).toEqual({ childTaskId: "c2" })
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd /Users/blackmount8/_repository/hummingbird-sa3b && bun test lib/client/agent/child-run-viewer/types.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `lib/client/agent/child-run-viewer/types.ts`:

```typescript
/**
 * Open-state for the child-run drill-in Sheet (subagent orchestration
 * PR-3b). Mirrors the text/pdf/csv viewer stores: one target at a time,
 * `open`/`close`. The `ChildRunModalHost` reads `target` + renders the
 * Sheet; `SubagentGroup` pills call `openChildRunViewer`.
 */

import { create } from "zustand"

export interface ChildRunViewerTarget {
  childTaskId: string
}

interface ChildRunViewerStore {
  target: ChildRunViewerTarget | null
  open: (target: ChildRunViewerTarget) => void
  close: () => void
}

export const useChildRunViewer = create<ChildRunViewerStore>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))

/** Convenience opener (mirrors `openPdf` etc. in right-panel-slot). */
export function openChildRunViewer(target: ChildRunViewerTarget): void {
  useChildRunViewer.getState().open(target)
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test lib/client/agent/child-run-viewer/types.test.ts`.

- [ ] **Step 5: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-sa3b
git add lib/client/agent/child-run-viewer/types.ts lib/client/agent/child-run-viewer/types.test.ts
git commit -m "feat(agent): child-run-viewer store (open/close target)"
```

---

### Task 2: Child-run Sheet host + view

**Files:**
- Create: `components/agent/child-run-modal.tsx`

(No unit test — the repo has no React component-test harness; this is covered by typecheck/lint in Task 4 + the manual smoke. Do NOT stand up a React test runner.)

- [ ] **Step 1: Read** `components/text-viewer/text-viewer.tsx` (the `Host` + the `<Sheet open={true} onOpenChange=…><SheetContent side="right">` render + the imports) and `lib/client/hooks/use-task-run.ts` (the `useTaskRun()` return). Mirror the Sheet structure.

- [ ] **Step 2: Implement** — `components/agent/child-run-modal.tsx`:

```tsx
"use client"

/**
 * Child-run drill-in (subagent orchestration PR-3b). A right-side Sheet
 * that tails one child subagent task's run, read-only. Opened from the
 * task strip's SubagentGroup via `openChildRunViewer`. Mirrors the
 * text/pdf viewer Host + Sheet pattern.
 */

import { useEffect } from "react"

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { TaskStrip } from "@/components/agent/task-strip"
import { useTaskRun } from "@/client/hooks/use-task-run"
import { useChildRunViewer } from "@/client/agent/child-run-viewer/types"

export function ChildRunModalHost() {
  const target = useChildRunViewer((s) => s.target)
  const close = useChildRunViewer((s) => s.close)
  if (!target) return null
  // key on childTaskId so switching children remounts the view (fresh
  // useTaskRun + stream); closing unmounts → the hook aborts its stream.
  return (
    <ChildRunView key={target.childTaskId} childTaskId={target.childTaskId} onClose={close} />
  )
}

function ChildRunView({
  childTaskId,
  onClose,
}: {
  childTaskId: string
  onClose: () => void
}) {
  const run = useTaskRun()
  useEffect(() => {
    void run.resume(childTaskId, 0)
    // run.resume is stable from useTaskRun (useCallback); childTaskId is
    // the only input that should re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childTaskId])

  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="shrink-0 pl-4 pr-12 py-2.5 border-b border-[var(--border)] space-y-0">
          <SheetTitle className="text-sm">Subagent run</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TaskStrip
            view={run.view}
            runId={run.runId}
            isRunning={run.isRunning}
            error={run.error}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

> NOTE: confirm the `SheetContent` className/layout against `text-viewer.tsx`'s `SheetContent` (match its `side="right"` + sizing classes so the drawer looks consistent). The exact Tailwind classes above mirror text-viewer's drawer; adjust to match if that file differs. Confirm the `useTaskRun` import path alias (`@/client/hooks/use-task-run`) + the `useChildRunViewer` path (`@/client/agent/child-run-viewer/types`) resolve (the repo uses `@/client/*` for `lib/client/*`).

- [ ] **Step 3: Typecheck** — `cd /Users/blackmount8/_repository/hummingbird-sa3b && bun run typecheck 2>&1 | tail -5` (clean). If `TaskStrip` isn't exported from `@/components/agent/task-strip`, confirm its export name + fix the import.

- [ ] **Step 4: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-sa3b
git add components/agent/child-run-modal.tsx
git commit -m "feat(agent): ChildRunModalHost — read-only Sheet tailing a child run"
```

---

### Task 3: Clickable pills + mount the host

**Files:**
- Modify: `components/agent/task-strip.tsx` (`SubagentGroup`)
- Modify: `app/dashboard/page.tsx`

- [ ] **Step 1: Make the pills clickable.** In `components/agent/task-strip.tsx`, change each child `<li>` row in `SubagentGroup` (currently `:457-465`) to a button that opens the viewer. Replace the row body:

```tsx
      {childRuns.map((c) => (
        <li key={c.childTaskId}>
          <button
            type="button"
            onClick={() => openChildRunViewer({ childTaskId: c.childTaskId })}
            className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-[var(--muted)]"
          >
            <span className="rounded-sm bg-[var(--muted)] px-1 py-0.5 text-[10px] leading-none text-[var(--muted-foreground)]">
              {subagentPillLabel(c.childTaskId, statuses)}
            </span>
            <span className="font-medium">{c.agent}</span>
            <span className="text-[var(--muted-foreground)] truncate">{c.subgoal}</span>
          </button>
        </li>
      ))}
```

Add the import at the top of `task-strip.tsx` (beside the other `@/client/...` imports):
```tsx
import { openChildRunViewer } from "@/client/agent/child-run-viewer/types"
```

- [ ] **Step 2: Mount the host.** In `app/dashboard/page.tsx`, add the import (beside the other viewer-host imports ~:11-17):
```tsx
import { ChildRunModalHost } from "@/components/agent/child-run-modal"
```
and render it in `DashboardShell` beside the other hosts (after `<CommandPalette />` ~:128):
```tsx
      <ChildRunModalHost />
```

- [ ] **Step 3: Typecheck + lint** — `cd /Users/blackmount8/_repository/hummingbird-sa3b && bun run typecheck 2>&1 | tail -5 && bun run lint 2>&1 | tail -6` (clean / 0 errors; fix any import-order lint in the two files).

- [ ] **Step 4: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-sa3b
git add components/agent/task-strip.tsx app/dashboard/page.tsx
git commit -m "feat(task-strip): open child-run drill-in on pill click; mount host"
```

---

### Task 4: Full gate

**Files:** none.

- [ ] **Step 1: repo gate** — `cd /Users/blackmount8/_repository/hummingbird-sa3b && bun run check` (typecheck clean, lint 0 errors, all tests pass incl. the new store test).
- [ ] **Step 2: Commit any gate fixes** (only if needed): `git add -A && git commit -m "chore: gate fixes for subagent PR-3b" || echo "nothing to commit"`.

---

## Notes for the PR description

- PR-3b of `docs/PLAN-subagent-orchestration.md` (client surfacing, second slice).
- Clicking a subagent pill in the task strip opens a right-side Sheet (`ChildRunModalHost`) that tails that child task's run via a standalone `useTaskRun().resume(childTaskId)` and renders a read-only `TaskStrip`. `key={childTaskId}` ensures clean remount/stream-abort on close or child-switch.
- Reuses the existing viewer store/host/Sheet pattern; `TaskStrip` callbacks omitted → read-only.
- Store unit-tested; the modal render + click are covered by typecheck/lint + the manual smoke (no React component-test harness in the repo).
- **Verification caveat:** fully exercisable only once the PR-2 spawn loop is live-smoke-verified (model + Postgres).
- No migration, no wire-schema change. Canvas node tree (PR-3c) still deferred (needs tasks-as-canvas-nodes).
