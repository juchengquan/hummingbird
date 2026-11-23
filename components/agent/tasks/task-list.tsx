"use client"

/**
 * The Tasks panel on runs (Q69): every task of the user, across
 * conversations, in the order the tasks interface gives them (needing an
 * answer first, then running, then ended). Several can run at once, up
 * to the cap (Q72), shown at the top.
 */

import { Loader2 } from "lucide-react"

import { useTasks } from "@/client/runs/tasks/context"

import { capLabel } from "./phase"
import { TaskCard } from "./task-card"

export function TaskList() {
  const tasks = useTasks()

  if (tasks.availability.ok === false && tasks.availability.reason === "signed_out") {
    return (
      <p className="text-xs text-[var(--muted-foreground)]">
        Sign in to run tasks. A task keeps working in the background, and its
        result is written into its conversation.
      </p>
    )
  }

  const list = tasks.tasks
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[var(--muted-foreground)] tabular-nums">
        {capLabel(tasks.activeCount, tasks.activeLimit)}
      </p>
      {tasks.listError ? (
        <p role="alert" className="break-words text-xs text-[var(--destructive)]">
          Couldn&apos;t refresh the tasks: {tasks.listError.message}. Retrying…
        </p>
      ) : null}
      {list === null ? (
        <p className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
          <Loader2 size={12} className="animate-spin" />
          Loading tasks…
        </p>
      ) : list.length === 0 ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          No tasks yet. Turn on “Task” in the chat header and send a message,
          or type <code>/research</code> and a question.
        </p>
      ) : (
        <ul aria-label="Tasks" className="space-y-2">
          {list.map((task) => (
            <TaskCard key={task.rootRunId} task={task} />
          ))}
        </ul>
      )}
    </div>
  )
}
