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
import { ensureTaskNotificationPermission } from "@/client/agent/notify"
import { settleTask, type TaskMeta } from "@/client/agent/settle-task"
import { useChildRuns, type ChildRuns } from "@/client/agent/use-child-runs"
import { modelSwitchNote } from "@/client/hooks/use-model-backend"
import { useHydrated, useStore } from "@/client/hooks/use-store"
import { useTaskRun } from "@/client/hooks/use-task-run"
import { isTerminalStatus } from "@/shared/agent/events"
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

export function TaskRunProvider({ children }: { children: ReactNode }) {
  const setTasksPanelOpen = useStore((s) => s.setTasksPanelOpen)
  const hydrated = useHydrated()

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
  })
  const { start, resume } = run
  const childRuns = useChildRuns(run.runId, run.isRunning, run.view.childRuns.length)

  const startTask = useCallback(
    (body: TaskRequestInput, opts?: StartTaskOptions) => {
      const cardId = opts?.projectTaskId
      const revertCard = () => {
        if (cardId) useStore.getState().moveProjectTask(cardId, "todo", 0)
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
        })
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
    if (!hydrated) return
    const pointer = loadActiveTask()
    if (!pointer) return
    if (isTerminalStatus(pointer.status)) {
      clearActiveTask(pointer.runId)
      return
    }
    const mode = pointer.mode ?? "default"
    metaRef.current.set(pointer.runId, {
      conversationId: pointer.conversationId,
      title: pointer.title,
      mode,
    })
    setRunConversationId(pointer.conversationId)
    setRunTitle(pointer.title ?? null)
    setRunMode(mode)
    setTasksPanelOpen(true)
    resume(pointer.runId)
  }, [hydrated, resume, setTasksPanelOpen])

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
