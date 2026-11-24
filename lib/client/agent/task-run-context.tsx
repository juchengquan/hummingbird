"use client"
import "client-only"

/**
 * Shares one long-running task across the chat panel (launch + inline
 * pointer), the project board and the Tasks panel (the live control
 * room), so all render the same `TaskRunView`. v1 drives a single run at
 * a time (`useTaskRun`); what its end does in this browser — the result
 * `Message` (the app is local-first + push sync, so a server-side insert
 * would fight the sync model), the research hand-off, the board card, the
 * notification — is `settleTask`, once per run.
 *
 * Mount once near the dashboard root, above both consumers.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { toast } from "sonner"

import { clearActiveTask, loadActiveTask, saveActiveTask } from "@/client/agent/active-task"
import { ensureTaskNotificationPermission, notifyTaskNeedsAnswer } from "@/client/agent/notify"
import { settleTask, type TaskMeta } from "@/client/agent/settle-task"
import { useChildRuns, type ChildRuns } from "@/client/agent/use-child-runs"
import { useAuth } from "@/client/hooks/use-auth"
import { modelSwitchNote } from "@/client/hooks/use-model-backend"
import { useHydrated, useStore } from "@/client/hooks/use-store"
import { useTaskRun } from "@/client/hooks/use-task-run"
import { isTerminalStatus } from "@/shared/agent/events"
import type { ActiveTaskRecord } from "@/shared/agent/active-task"
import type { TaskRunView } from "@/shared/agent/project"
import type { TaskRequestInput } from "@/shared/api-schemas"
import { TASK_MODEL_BACKEND, taskModelFor } from "@/shared/backend-models"

interface StartTaskOptions {
  title?: string
  /** The board card this launches: it carries the run id, and goes back
   *  to To-do when the start fails. */
  projectTaskId?: string
}

interface TaskRunContextValue {
  view: TaskRunView
  runId: string | null
  isRunning: boolean
  isCancelling: boolean
  error: string | null
  /** The active run's sub-agents, and their open questions. */
  childRuns: ChildRuns
  /** The conversation the active run belongs to (for the inline pointer
   *  in the thread). Null when no run has started this session. */
  runConversationId: string | null
  /** The active run's title (its goal), for the panel's heading. */
  runTitle: string | null
  /** The board card whose launch the server hasn't accepted yet. */
  launchingCardId: string | null
  /** The chat-input "Run as task" mode toggle. */
  runAsTask: boolean
  setRunAsTask: (v: boolean) => void
  /** Task mode of the active run (default / research, etc.). Carried
   *  in the context so settled-task UI (e.g. the research "Open in
   *  editor" button) can branch without reading the server checkpoint.
   *  `null` until a run starts. */
  runMode: "default" | "research" | null
  /** Launch a task: switches a model the worker can't run (Q55), records
   *  the conversation, opens the panel, watches. */
  startTask: (body: TaskRequestInput, opts?: StartTaskOptions) => void
  cancel: () => Promise<void>
  /** Re-read the active run. */
  refresh: () => void
}

const TaskRunContext = createContext<TaskRunContextValue | null>(null)

/**
 * Why a new old-path launch must wait, or null (survey bug 1): this path
 * follows one task at a time, so a second launch — `/research` skipped the
 * chat's guard, another tab didn't see it — stopped watching the first,
 * whose result was then never delivered in this browser. Another tab's
 * task shows as the user's saved pointer naming another run.
 */
export function oldPathLaunchBlocked(
  runningHere: boolean,
  pointer: Pick<ActiveTaskRecord, "runId" | "status"> | null,
  watchedRunId: string | null
): string | null {
  if (runningHere) return "A task is already running. Wait for it to finish, or cancel it."
  if (pointer && !isTerminalStatus(pointer.status) && pointer.runId !== watchedRunId) {
    return "A task is already running in another tab."
  }
  return null
}

export function TaskRunProvider({ children }: { children: ReactNode }) {
  const setTasksPanelOpen = useStore((s) => s.setTasksPanelOpen)
  const hydrated = useHydrated()
  // The pointer and the derived result ids are the signed-in user's
  // (survey bug 6, Q70): null signed out or without Supabase, undefined
  // while the session is still being read.
  const { status: authStatus, user } = useAuth()
  const userId: string | null | undefined =
    authStatus === "loading" ? undefined : authStatus === "signed-in" ? (user?.id ?? null) : null
  const userIdRef = useRef(userId)
  useEffect(() => {
    userIdRef.current = userId
  }, [userId])

  const [runAsTask, setRunAsTask] = useState(false)
  const [runConversationId, setRunConversationId] = useState<string | null>(null)
  const [runTitle, setRunTitle] = useState<string | null>(null)
  const [runMode, setRunMode] = useState<"default" | "research" | null>(null)
  const [launchingCardId, setLaunchingCardId] = useState<string | null>(null)

  // By run id: a run can settle after the next one has been launched.
  const metaRef = useRef(new Map<string, TaskMeta>())
  const run = useTaskRun({
    onSettled: (runId, view) => {
      const meta = metaRef.current.get(runId)
      if (meta) void settleTask(runId, view, meta)
    },
    // Not this account's (or deleted): forget the pointer, settle nothing.
    onGone: (runId) => {
      const meta = metaRef.current.get(runId)
      if (meta) clearActiveTask(runId, meta.userId)
    },
  })
  const { start, resume } = run
  const isRunningRef = useRef(run.isRunning)
  const runIdRef = useRef(run.runId)
  useEffect(() => {
    isRunningRef.current = run.isRunning
    runIdRef.current = run.runId
  }, [run.isRunning, run.runId])
  const childRuns = useChildRuns(run.runId, run.isRunning, run.view.childRuns.length)

  const startTask = useCallback(
    (body: TaskRequestInput, opts?: StartTaskOptions) => {
      const cardId = opts?.projectTaskId
      const revertCard = () => {
        if (cardId) useStore.getState().moveProjectTask(cardId, "todo", 0)
      }
      const userId = userIdRef.current ?? null
      const blocked = oldPathLaunchBlocked(isRunningRef.current, loadActiveTask(userId), runIdRef.current)
      if (blocked) {
        toast.error(blocked)
        revertCard()
        return
      }
      // Every launch passes here, whatever picked the model: the toggle,
      // `/research`, the board, a persona or a workspace (Q55).
      const { model, switchedFrom } = taskModelFor(body.model)
      if (!model) {
        toast.error("No configured model can run tasks.")
        revertCard()
        return
      }
      if (switchedFrom) toast.info(modelSwitchNote(TASK_MODEL_BACKEND, switchedFrom, model))

      const meta: TaskMeta = {
        conversationId: body.conversationId,
        title: opts?.title,
        mode: body.mode ?? "default",
        userId,
      }
      setRunConversationId(meta.conversationId)
      setRunTitle(meta.title ?? null)
      setRunMode(meta.mode)
      setLaunchingCardId(cardId ?? null)
      setTasksPanelOpen(true)

      void start({ ...body, model }).then((res) => {
        if (cardId) setLaunchingCardId((id) => (id === cardId ? null : id))
        if (!res?.ok || !res.runId) {
          revertCard()
          if (res) {
            toast.error(`Couldn't start the task: ${res.error?.message ?? `HTTP ${res.status}.`}`)
          }
          return
        }
        metaRef.current.set(res.runId, meta)
        saveActiveTask({
          runId: res.runId,
          conversationId: meta.conversationId,
          cursor: 0,
          status: "queued",
          title: meta.title,
          ...(meta.mode !== "default" ? { mode: meta.mode } : {}),
          updatedAt: new Date().toISOString(),
        }, userId)
        if (cardId) useStore.getState().updateProjectTask(cardId, { taskId: res.runId })
      })
    },
    [start, setTasksPanelOpen]
  )

  // Notification permission is best requested on a user gesture — ask
  // when the user opts into task mode (a settled task fires a
  // finish-while-away notification; see `settleTask`).
  const handleSetRunAsTask = useCallback((v: boolean) => {
    setRunAsTask(v)
    if (v) void ensureTaskNotificationPermission()
  }, [])

  // Resume-on-reload: watch the saved run again, from the start of its log
  // (the view is empty; `settleTask` keeps the replay from repeating side
  // effects, which is also why this waits for the store to hydrate). The
  // stream reconciles dead runs when it opens, so a run that died while
  // away replays its synthetic failure and settles.
  useEffect(() => {
    if (!hydrated || userId === undefined) return
    const pointer = loadActiveTask(userId)
    if (!pointer) return
    if (isTerminalStatus(pointer.status)) {
      clearActiveTask(pointer.runId, userId)
      return
    }
    const mode = pointer.mode ?? "default"
    metaRef.current.set(pointer.runId, {
      conversationId: pointer.conversationId,
      title: pointer.title,
      mode,
      userId,
    })
    setRunConversationId(pointer.conversationId)
    setRunTitle(pointer.title ?? null)
    setRunMode(mode)
    setTasksPanelOpen(true)
    resume(pointer.runId)
  }, [hydrated, userId, resume, setTasksPanelOpen])

  // A question for the user — the task's own or a sub-agent's — notifies a
  // hidden tab, once per question (Q74, survey bug 3).
  const pending = run.view.pendingInput
  const watchedRunId = run.runId
  useEffect(() => {
    if (!watchedRunId || !pending) return
    const title = metaRef.current.get(watchedRunId)?.title
    notifyTaskNeedsAnswer(watchedRunId, pending.requestId, { title, prompt: pending.prompt })
  }, [watchedRunId, pending])
  useEffect(() => {
    if (!watchedRunId) return
    const title = metaRef.current.get(watchedRunId)?.title
    for (const child of childRuns.asking) {
      if (child.pendingInput) {
        notifyTaskNeedsAnswer(child.id, child.pendingInput.requestId, {
          title,
          prompt: child.pendingInput.prompt,
        })
      }
    }
  }, [watchedRunId, childRuns.asking])

  const value: TaskRunContextValue = {
    view: run.view,
    runId: run.runId,
    isRunning: run.isRunning,
    isCancelling: run.isCancelling,
    error: run.error,
    childRuns,
    runConversationId,
    runTitle,
    launchingCardId,
    runAsTask,
    setRunAsTask: handleSetRunAsTask,
    runMode,
    startTask,
    cancel: run.cancel,
    refresh: run.refresh,
  }

  return (
    <TaskRunContext.Provider value={value}>{children}</TaskRunContext.Provider>
  )
}

export function useTaskRunContext(): TaskRunContextValue {
  const ctx = useContext(TaskRunContext)
  if (!ctx) {
    throw new Error("useTaskRunContext must be used within a TaskRunProvider")
  }
  return ctx
}
