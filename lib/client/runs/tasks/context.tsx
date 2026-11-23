"use client"
import "client-only"

/**
 * The React plumbing of the tasks interface (`./types.ts`): the context,
 * the provider a `TasksContextValue` is handed to, and the two hooks every
 * surface uses. No behaviour: wave 6-C builds the value, a test or a
 * story can hand in a fake one.
 */

import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react"

import type { TasksContextValue, TaskView } from "./types"

const TasksContext = createContext<TasksContextValue | null>(null)

export function TasksProvider({
  value,
  children,
}: {
  value: TasksContextValue
  children: ReactNode
}) {
  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
}

/** The tasks interface. Throws outside a `TasksProvider`. */
export function useTasks(): TasksContextValue {
  const value = useContext(TasksContext)
  if (!value) throw new Error("useTasks must be used within a TasksProvider")
  return value
}

const NOOP_UNSUBSCRIBE = () => {}

/**
 * One task, followed while the calling component is mounted (only watched
 * tasks are streamed); null when it isn't listed, or for a null id.
 */
export function useTaskView(rootRunId: string | null): TaskView | null {
  const tasks = useTasks()
  const subscribe = useCallback(
    (onChange: () => void) =>
      rootRunId === null ? NOOP_UNSUBSCRIBE : tasks.subscribeTask(rootRunId, onChange),
    [tasks, rootRunId],
  )
  const snapshot = useCallback(
    () => (rootRunId === null ? null : tasks.getTask(rootRunId)),
    [tasks, rootRunId],
  )
  return useSyncExternalStore(subscribe, snapshot, () => null)
}
