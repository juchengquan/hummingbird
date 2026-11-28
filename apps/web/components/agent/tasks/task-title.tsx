"use client"

/**
 * A task's title, the same in the runs list and the old single-task
 * panel: its goal's first line, and its conversation's name under it
 * (when this browser has the conversation).
 */

import { useStore } from "@/client/hooks/use-store"

import { taskGoalLine } from "./phase"

export function TaskTitle({
  goal,
  conversationId,
}: {
  goal: string | null | undefined
  conversationId: string | null | undefined
}) {
  const conversation = useStore((s) =>
    conversationId ? s.conversations.find((c) => c.id === conversationId)?.title : undefined,
  )
  return (
    <span className="block min-w-0">
      <span data-task-title className="block truncate font-medium">
        {taskGoalLine(goal)}
      </span>
      {conversation ? (
        <span data-task-conversation className="block truncate text-[11px] font-normal text-[var(--muted-foreground)]">
          {conversation}
        </span>
      ) : null}
    </span>
  )
}
