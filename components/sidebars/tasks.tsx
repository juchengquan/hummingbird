"use client"

import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { TaskList } from "@/components/agent/tasks/task-list"
import { useStore } from "@/client/hooks/use-store"
import { cn } from "@/shared/utils"

// Match the resources rail's content width so the chat column reflows
// the same way when either panel opens.
const CONTENT_WIDTH_CLASS = "w-[272px]"

/**
 * The live control room for long-running tasks: every task of the user
 * (`TaskList`, Q61/Q69) — status, plan, tool pills, questions, Cancel.
 * Collapses to zero width when closed; reopened from the inline pointer
 * in the chat thread or the header's Tasks button.
 */
export function TasksSidebar() {
  const open = useStore((s) => s.tasksPanelOpen)
  const setOpen = useStore((s) => s.setTasksPanelOpen)

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
            <TaskList />
          </div>
        </div>
      </div>
    </aside>
  )
}
