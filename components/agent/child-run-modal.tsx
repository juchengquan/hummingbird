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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childTaskId])

  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent
        side="right"
        className="w-full sm:w-[640px] sm:max-w-[80vw] p-0 gap-0 flex flex-col"
      >
        <SheetHeader className="shrink-0 pl-4 pr-12 py-2.5 border-b border-[var(--border)] space-y-0">
          <SheetTitle className="text-sm">Subagent run</SheetTitle>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
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
