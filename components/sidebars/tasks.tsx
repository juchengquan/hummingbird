"use client"

import { useCallback } from "react"
import { Loader2, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { TaskStrip } from "@/components/agent/task-strip"
import { TaskList } from "@/components/agent/tasks/task-list"
import { TaskTitle } from "@/components/agent/tasks/task-title"
import { useStore } from "@/client/hooks/use-store"
import { useTaskRunContext } from "@/client/agent/task-run-context"
import { useTasks } from "@/client/runs/tasks/context"
import { cn } from "@/shared/utils"

// Match the resources rail's content width so the chat column reflows
// the same way when either panel opens.
const CONTENT_WIDTH_CLASS = "w-[272px]"

/**
 * The live control room for long-running tasks. Opens when a task is
 * launched (`startTask`) and renders the active run's full `TaskRunView`
 * via `TaskStrip` — status + step counter, plan, tool pills, streaming
 * text, questions, Cancel. Collapses to zero width when closed; reopened from the
 * inline pointer in the chat thread.
 *
 * On "agent-py (runs)" (Q61, Q69) it lists every task of the user
 * (`TaskList`); otherwise it shows the old path's single active run.
 */
export function TasksSidebar() {
  const open = useStore((s) => s.tasksPanelOpen)
  const setOpen = useStore((s) => s.setTasksPanelOpen)
  const { availability } = useTasks()
  const onRuns = availability.ok || availability.reason === "signed_out"
  const appendToActiveDocumentOrCreate = useStore(
    (s) => s.appendToActiveDocumentOrCreate
  )
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const {
    view,
    runId,
    isRunning,
    isCancelling,
    error,
    childRuns,
    cancel,
    refresh,
    runMode,
    runTitle,
    runConversationId,
  } = useTaskRunContext()

  // Research-mode tasks produce a Markdown report — Phase 1 hands it
  // off to the editor on demand. `appendToActiveDocumentOrCreate` will
  // create a workspace doc if none is active, and set it active so the
  // editor panel snaps to it. See `PLAN-deep-research.md`.
  const handleOpenInEditor = useCallback(() => {
    const text = view.resultText?.trim()
    if (!text) return
    if (!activeWorkspaceId) {
      toast.error("Select a workspace first")
      return
    }
    appendToActiveDocumentOrCreate(text)
    toast.success("Report added to the editor")
  }, [view.resultText, activeWorkspaceId, appendToActiveDocumentOrCreate])

  const onOpenInEditor =
    runMode === "research" ? handleOpenInEditor : undefined

  return (
    // Opaque and above the chat: on a phone the chat's header overflows into it.
    <aside
      data-state={open ? "expanded" : "collapsed"}
      className="relative z-10 h-full flex shrink-0 bg-[var(--background)]"
    >
      <div
        // Closed, it is only shrunk to nothing: out of the tab order and the
        // accessibility tree too (Q89).
        inert={!open}
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
            {onRuns ? (
              <TaskList />
            ) : runId ? (
              <div className="space-y-2">
              <p className="text-xs">
                <TaskTitle goal={runTitle} conversationId={runConversationId} />
              </p>
              <TaskStrip
                view={view}
                isRunning={isRunning}
                runId={runId}
                childState={childRuns}
                error={error}
                cancelling={isCancelling}
                onCancel={cancel}
                onStale={refresh}
                onOpenInEditor={onOpenInEditor}
                openInEditorLabel="Open report in editor"
              />
              </div>
            ) : isRunning ? (
              <p className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                <Loader2 size={12} className="animate-spin" />
                Starting the task…
              </p>
            ) : error ? (
              <p role="alert" className="text-xs text-[var(--destructive)] break-words">
                Couldn&apos;t start the task: {error}
              </p>
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
