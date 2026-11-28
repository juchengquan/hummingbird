"use client"
import "client-only"

/**
 * A task started the old way (`/api/tasks`, before wave 13) left a pointer
 * in this browser (`humm.activeTask.<userId>`). It is the same `tasks` row
 * the runs list shows, watches, answers, cancels and delivers (Q126), so
 * this only hands it over: the Tasks panel opens on it once, and the
 * pointer goes once the list shows the task ended (it is delivered from
 * there) or doesn't list it (`./old-pointer.ts`).
 *
 * Mount once near the dashboard root, inside `TasksProvider`.
 */

import { useEffect, useRef } from "react"

import { clearActiveTask, loadActiveTask } from "@/client/agent/active-task"
import { pointerPlan, runsHandOff } from "@/client/agent/old-pointer"
import { useAuth } from "@/client/hooks/use-auth"
import { useHydrated, useStore } from "@/client/hooks/use-store"
import { useTasks } from "@/client/runs/tasks/context"
import { useTaskFocus } from "@/components/agent/tasks/focus"

export function OldTaskPointerHandOff(): null {
  const setTasksPanelOpen = useStore((s) => s.setTasksPanelOpen)
  const hydrated = useHydrated()
  // The pointer is the signed-in user's (survey bug 6, Q70): null signed
  // out or without Supabase, undefined while the session is still read.
  const { status: authStatus, user } = useAuth()
  const userId: string | null | undefined =
    authStatus === "loading" ? undefined : authStatus === "signed-in" ? (user?.id ?? null) : null
  const tasks = useTasks()
  const handedOffRef = useRef<string | null>(null)

  useEffect(() => {
    if (!hydrated || userId === undefined) return
    const owner = userId ?? null
    const pointer = loadActiveTask(owner)
    if (!pointer) return
    const plan = pointerPlan(pointer, tasks.availability)
    if (plan === "clear") {
      clearActiveTask(pointer.runId, owner)
      return
    }
    if (plan !== "runs") return
    const next = runsHandOff(pointer, { tasks: tasks.tasks, listError: tasks.listError })
    if (next === "clear") clearActiveTask(pointer.runId, owner)
    if (next !== "focus" || handedOffRef.current === pointer.runId) return
    handedOffRef.current = pointer.runId
    useTaskFocus.getState().focus(pointer.runId)
    setTasksPanelOpen(true)
  }, [hydrated, userId, tasks.availability, tasks.tasks, tasks.listError, setTasksPanelOpen])

  return null
}
