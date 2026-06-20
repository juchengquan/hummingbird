# Subagent orchestration PR-3b — child-run drill-in — design

Status: **approved design**, ready for implementation plan.
Date: 2026-06-20. Parent plan:
[`docs/PLAN-subagent-orchestration.md`](../../PLAN-subagent-orchestration.md)
(second slice of PR-3 — client surfacing).

## Goal

Clicking a spawned-subagent pill in the task strip opens a right-side
Sheet showing that child task's live run (its own `TaskStrip`),
read-only. Built on PR-3a's `SubagentGroup` / `TaskRunView.childRuns`.

## Why it composes cleanly (from recon)

- `useTaskRun()` (`lib/client/hooks/use-task-run.ts`) runs **standalone**:
  no `TaskRunContext` coupling; `resume(runId, cursor=0)` sets up its own
  SSE + realtime tail for any task id; event folding is idempotent by
  `seq`, so a second instance (the child) can't conflict with the parent
  run. Returns `{ view, runId, isRunning, error, resume, ... }`.
- `TaskStrip` (`components/agent/task-strip.tsx`) is prop-driven and all
  its callbacks (`onCancel`/`onRespond`/`onOpenInEditor`) are **optional**
  — a read-only child view simply omits them (the Cancel button + HITL
  card are gated on the callbacks being present).
- The viewer pattern (`components/text-viewer/`): a zustand store holding
  the open `target` + `open`/`close`, and a `…Host` component that renders
  a Sheet when `target` is set, mounted in `app/dashboard/page.tsx`.

## Components

### 1. Viewer store — `lib/client/agent/child-run-viewer/types.ts`

Mirror `components/text-viewer/types.ts`:

```ts
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

/** Convenience opener (mirrors `openPdf` etc.). */
export function openChildRunViewer(target: ChildRunViewerTarget): void {
  useChildRunViewer.getState().open(target)
}
```

### 2. The Sheet host + view — `components/agent/child-run-modal.tsx`

```tsx
export function ChildRunModalHost() {
  const target = useChildRunViewer((s) => s.target)
  const close = useChildRunViewer((s) => s.close)
  // Render the Sheet whenever a target is set; key on childTaskId so a
  // switch to a different child remounts the view (fresh stream).
  return (
    <Sheet open={!!target} onOpenChange={(o) => { if (!o) close() }}>
      <SheetContent>
        {target ? <ChildRunView key={target.childTaskId} childTaskId={target.childTaskId} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function ChildRunView({ childTaskId }: { childTaskId: string }) {
  const run = useTaskRun()
  useEffect(() => { void run.resume(childTaskId, 0) }, [childTaskId])
  return (
    <>
      <SheetHeader><SheetTitle>Subagent run</SheetTitle></SheetHeader>
      <TaskStrip view={run.view} runId={run.runId} isRunning={run.isRunning} error={run.error} />
    </>
  )
}
```

- Uses the same `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle` imports
  the other viewers use.
- `resume(childTaskId, 0)` replays the child's full event log to its
  current state (settled child → final state; running child → live tail).
- No `onCancel`/`onRespond` passed → read-only strip.
- `key={target.childTaskId}` so opening a different child remounts (fresh
  hook + stream); unmount/close aborts the stream via the hook's cleanup.

### 3. Make the pills clickable — `components/agent/task-strip.tsx`

In `SubagentGroup`, wrap each child row's content in a `<button>` that
calls `openChildRunViewer({ childTaskId: c.childTaskId })` (Option B — the
strip calls the opener directly, like the file panels call `openPdf`).
Keep the existing pill + persona + subgoal layout inside the button;
style it as a clickable row (hover affordance), keyboard-accessible
(`<button>` is focusable). Import `openChildRunViewer` from the store
module.

### 4. Mount — `app/dashboard/page.tsx`

Add `<ChildRunModalHost />` in `DashboardShell` alongside the other
viewer hosts (after `CommandPalette` / beside `TextViewerHost`).

## Error handling / edges

- **Settled child** → `resume(id, 0)` replays to the final state; the
  strip shows the terminal one-liner.
- **Running child** → live tail; closing mid-run aborts the hook's stream
  (cleanup on unmount; `key` ensures unmount on close).
- **Switching children** without closing → `key={childTaskId}` remounts
  `ChildRunView`, so the previous stream aborts and the new one starts.
- **resume failure** → the hook sets `error`; `TaskStrip` renders it.

## Testing

- **`useChildRunViewer` store** (`bun:test`): `open(target)` sets
  `target`; `close()` clears it; `openChildRunViewer` calls `open`.
- The modal render + click wiring: the repo has **no React
  component-test harness**, so these are covered by `bun run typecheck` /
  `bun run lint` + the manual smoke (consistent with PR-3a).
- **Manual smoke (deferred, needs live model+DB):** spawn subagents →
  click a pill → the Sheet opens showing the child's live run; the pills'
  status updates while the child runs; closing the Sheet stops its
  stream; switching to another child swaps the view.

## Scope boundary

- **PR-3b (this spec):** the drill-in Sheet only.
- **PR-3c (deferred):** the canvas node tree — still needs a `"task"`
  `CanvasNodeKind` + tasks-as-canvas-nodes (orchestrator tasks aren't
  canvas nodes today), then `placeRelatedNode` per child.

## Caveat

Like the rest of the arc, fully exercisable only once the PR-2 spawn loop
is live-smoke-verified (model + Postgres). PR-3b's store test +
typecheck/lint prove the wiring in isolation.
