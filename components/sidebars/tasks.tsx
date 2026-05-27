"use client"

import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { TaskStrip } from "@/components/agent/task-strip"
import { useStore } from "@/client/hooks/use-store"
import { useTaskRunContext } from "@/client/agent/task-run-context"
import { cn } from "@/shared/utils"

// Match the resources rail's content width so the chat column reflows
// the same way when either panel opens.
const CONTENT_WIDTH_CLASS = "w-[272px]"

/**
 * The live control room for long-running tasks. Opens when a task is
 * launched (`startTask`) and renders the active run's full `TaskRunView`
 * via `TaskStrip` — status + step counter, plan, tool pills, streaming
 * text, Cancel. Collapses to zero width when closed; reopened from the
 * inline pointer in the chat thread.
 *
 * v1 shows the single active run. A list of past runs (the sketch in
 * `PLAN-agent-tasks-followups.md`) needs a `tasks` list endpoint and is
 * a follow-up.
 */
export function TasksSidebar() {
  const open = useStore((s) => s.tasksPanelOpen)
  const setOpen = useStore((s) => s.setTasksPanelOpen)
  const { view, runId, isRunning, error, cancel } = useTaskRunContext()

  return (
    <aside data-state={open ? "expanded" : "collapsed"} className="h-full flex">
      <div
        className={cn(
          "h-full min-h-0 overflow-hidden transition-[width] duration-200 ease-out",
          open
            ? cn(CONTENT_WIDTH_CLASS, "border-l border-[var(--border)]")
            : "w-0 border-l-0"
        )}
      >
        <div className={cn("flex flex-col h-full", CONTENT_WIDTH_CLASS)}>
          <header className="shrink-0 h-11 flex items-center justify-between px-3 border-b border-[var(--border)]">
            <span className="text-sm font-medium">Tasks</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-[var(--muted-foreground)]"
              onClick={() => setOpen(false)}
              aria-label="Close tasks panel"
            >
              <X size={14} />
            </Button>
          </header>
          <div className="flex-1 min-h-0 overflow-auto p-3">
            {runId ? (
              <TaskStrip
                view={view}
                isRunning={isRunning}
                error={error}
                onCancel={cancel}
              />
            ) : (
              <p className="text-xs text-[var(--muted-foreground)]">
                No task running. Toggle “Run as task” in the chat header,
                then send a message to start one.
              </p>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
