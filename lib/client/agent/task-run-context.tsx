"use client"
import "client-only"

/**
 * Shares one long-running task across the chat panel (launch + inline
 * pointer) and the Tasks panel (the live control room), so both render
 * the same `TaskRunView`. v1 drives a single run at a time
 * (`useTaskRun`); the result of a run started here lands back in its
 * conversation as a normal assistant `Message` on settle — matching how
 * chat authors messages client-side (the app is local-first + push
 * sync, so a server-side insert would fight the sync model).
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

import { loadActiveTask } from "@/client/agent/active-task"
import { ensureTaskNotificationPermission } from "@/client/agent/notify"
import { useStore } from "@/client/hooks/use-store"
import { useTaskRun } from "@/client/hooks/use-task-run"
import { isTerminalStatus, type RunStatus } from "@/shared/agent/events"
import type { TaskRunView } from "@/shared/agent/project"
import { deriveResearchReportTitle } from "@/shared/agent/research-report"
import type {
  RespondRequestInput,
  TaskRequestInput,
} from "@/shared/api-schemas"

interface TaskRunContextValue {
  view: TaskRunView
  runId: string | null
  isRunning: boolean
  error: string | null
  /** The conversation the active run belongs to (for the inline pointer
   *  in the thread). Null when no run has started this session. */
  runConversationId: string | null
  /** The chat-input "Run as task" mode toggle. */
  runAsTask: boolean
  setRunAsTask: (v: boolean) => void
  /** Task mode of the active run (default / research, etc.). Carried
   *  in the context so settled-task UI (e.g. the research "Open in
   *  editor" button) can branch without reading the server checkpoint.
   *  `null` until a run starts. */
  runMode: "default" | "research" | null
  /** Launch a task: records its conversation, opens the panel, streams. */
  startTask: (body: TaskRequestInput, opts?: { title?: string }) => void
  cancel: () => Promise<void>
  /** Resolve a HITL pending input on the active paused run. */
  respond: (body: RespondRequestInput) => Promise<void>
}

const TaskRunContext = createContext<TaskRunContextValue | null>(null)

export function TaskRunProvider({ children }: { children: ReactNode }) {
  const addMessage = useStore((s) => s.addMessage)
  const setTasksPanelOpen = useStore((s) => s.setTasksPanelOpen)
  // Research-mode auto-handoff (Phase 2). The settled report lands in
  // a fresh workspace document AND a markdown artifact, so the user
  // sees the same content in both the editor panel + the workspace
  // artifacts list. The Phase 1 "Open report in editor" button on the
  // Tasks strip remains as a manual re-apply.
  const createDocument = useStore((s) => s.createDocument)
  const setDocumentContent = useStore((s) => s.setDocumentContent)
  const setActiveDocument = useStore((s) => s.setActiveDocument)
  const createArtifact = useStore((s) => s.createArtifact)
  const activeWorkspaceIdRef = useRef<string | null>(null)
  const activeWorkspaceIdLive = useStore((s) => s.activeWorkspaceId)
  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceIdLive
  }, [activeWorkspaceIdLive])

  const [runAsTask, setRunAsTask] = useState(false)
  const [runConversationId, setRunConversationId] = useState<string | null>(null)
  const [runTitle, setRunTitle] = useState<string | undefined>(undefined)
  const [runMode, setRunMode] = useState<"default" | "research" | null>(null)

  // Hook options are read at fold time via the hook's own ref, so
  // passing the latest run conversation/title here is enough for the
  // resume pointer + finish notification to target the right run.
  const run = useTaskRun({
    conversationId: runConversationId ?? undefined,
    title: runTitle,
    notifyOnFinish: true,
    mode: runMode ?? undefined,
  })

  // Author the result Message exactly once, on the running→done edge,
  // and only for a run launched here this session (so a future
  // resume-on-reload fold doesn't double-author an already-synced
  // message). The conversation is captured at launch, not read live, so
  // switching conversations mid-run still lands the answer in the right
  // thread.
  //
  // Research mode (Phase 2): on the same done edge, also hand the
  // report off to the editor — create a dedicated workspace document
  // titled from the report's first heading, set it active so the
  // editor snaps to it, and register a `kind: 'markdown'` artifact
  // linked back to the just-authored message.
  const prevStatusRef = useRef<RunStatus | null>(null)
  const runConvRef = useRef<string | null>(null)
  const runModeRef = useRef<"default" | "research" | null>(null)
  const status = run.view.status
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (prev === "done" || status !== "done") return
    const convId = runConvRef.current
    if (!convId) return
    const text = (run.view.resultText ?? run.view.text).trim()
    if (!text) return
    const msg = addMessage({ role: "assistant", content: text }, convId)

    if (runModeRef.current !== "research") return
    const workspaceId = activeWorkspaceIdRef.current
    if (!workspaceId) return
    const title = deriveResearchReportTitle(text, runConvRef.current ?? undefined)
    // Create a fresh doc per report rather than appending to the
    // active one — keeps each research run as its own deliverable so
    // a workspace can accumulate a library of reports. The Phase 1
    // manual button still appends-or-creates if the user wants the
    // mixed-content behaviour.
    const doc = createDocument(workspaceId, title)
    setDocumentContent(doc.id, text)
    setActiveDocument(doc.id)
    createArtifact({
      conversationId: convId,
      messageId: msg.id,
      kind: "markdown",
      title,
      content: text,
    })
    toast.success("Report opened in the editor")
  }, [
    status,
    run.view.resultText,
    run.view.text,
    addMessage,
    createDocument,
    setDocumentContent,
    setActiveDocument,
    createArtifact,
  ])

  const startTask = useCallback(
    (body: TaskRequestInput, opts?: { title?: string }) => {
      const mode = body.mode ?? "default"
      runConvRef.current = body.conversationId
      runModeRef.current = mode
      prevStatusRef.current = null
      setRunConversationId(body.conversationId)
      setRunTitle(opts?.title)
      setRunMode(mode)
      setTasksPanelOpen(true)
      void run.start(body)
    },
    [run, setTasksPanelOpen]
  )

  // Notification permission is best requested on a user gesture — ask
  // when the user opts into task mode (a settled task fires a
  // finish-while-away notification; see useTaskRun's notifyOnFinish).
  const handleSetRunAsTask = useCallback((v: boolean) => {
    setRunAsTask(v)
    if (v) void ensureTaskNotificationPermission()
  }, [])

  // Resume-on-reload: if a run was still active when the tab closed
  // (its localStorage pointer survives), reconnect and re-attach the
  // panel. The resume endpoint reconciles dead runs on reconnect, so a
  // run that died while away replays its synthetic failure and settles.
  // Runs once on mount; `run.resume` is reached via a ref so this
  // doesn't re-fire as the hook re-renders.
  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })
  const resumedRef = useRef(false)
  useEffect(() => {
    if (resumedRef.current) return
    resumedRef.current = true
    const pointer = loadActiveTask()
    if (!pointer || isTerminalStatus(pointer.status)) return
    const resumedMode = pointer.mode ?? "default"
    runConvRef.current = pointer.conversationId
    runModeRef.current = resumedMode
    prevStatusRef.current = null
    setRunConversationId(pointer.conversationId)
    setRunTitle(pointer.title)
    setRunMode(resumedMode)
    setTasksPanelOpen(true)
    void runRef.current.resume(pointer.runId, pointer.cursor)
  }, [setTasksPanelOpen])

  const respond = useCallback(
    async (body: RespondRequestInput) => {
      const id = run.runId
      if (!id) return
      await run.respond(id, body)
    },
    [run]
  )

  const value: TaskRunContextValue = {
    view: run.view,
    runId: run.runId,
    isRunning: run.isRunning,
    error: run.error,
    runConversationId,
    runAsTask,
    setRunAsTask: handleSetRunAsTask,
    runMode,
    startTask,
    cancel: run.cancel,
    respond,
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
