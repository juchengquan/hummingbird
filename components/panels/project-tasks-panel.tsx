"use client"

import "client-only"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { useDroppable } from "@dnd-kit/core"
import {
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  Play,
  Plus,
  Sparkles,
  X,
} from "lucide-react"
import { toast } from "sonner"

import {
  useActiveWorkspace,
  useStore,
  useWorkspaceProjectTasks,
} from "@/client/hooks/use-store"
import { useTaskRunContext } from "@/client/agent/task-run-context"
import { apiClient } from "@/client/api-client"
import { downloadAsFile, safeFilename } from "@/client/export"
import { resolveEnabledSkills } from "@/shared/skills/resolve-enabled-skills"
import { columnTasks, PROJECT_TASK_COLUMNS } from "@/shared/project-tasks"
import {
  projectProgress,
  projectToMarkdown,
} from "@/shared/project-markdown"
import type { TaskRequestInput } from "@/shared/api-schemas"
import type { ProjectTask, ProjectTaskStatus } from "@/shared/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/shared/utils"

/**
 * Live state for the one card whose run is currently being observed.
 * Threaded down to the cards so the active card shows a spinner + step
 * counter (mirroring the chat-header task strip). Only one run is in
 * flight at a time — the substrate (`useTaskRun`) is single-run.
 */
interface CardRunInfo {
  /** The runId of the active run, matched against `task.taskId`. */
  activeRunId: string | null
  /** The card optimistically moved to In progress before its runId
   *  arrived — matched against `task.id` so the spinner shows instantly. */
  pendingCardId: string | null
  running: boolean
  step: number
  maxSteps: number | null
}

const COLUMN_LABELS: Record<ProjectTaskStatus, string> = {
  todo: "To-do",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
}

/**
 * Project-mode Kanban board (Phase 2). Three columns; drag a card to
 * reorder within a column or move it across. Manual add per the To-do
 * column; the "break this down" AI action + per-card "Run as task"
 * land in Phases 3/4. Only mounts for project workspaces (the rail tab
 * is gated on `workspace.isProject`).
 */
export function ProjectTasksPanel() {
  const workspace = useActiveWorkspace()
  const tasks = useWorkspaceProjectTasks()
  const createProjectTask = useStore((s) => s.createProjectTask)
  const moveProjectTask = useStore((s) => s.moveProjectTask)
  const updateProjectTask = useStore((s) => s.updateProjectTask)
  const createArtifact = useStore((s) => s.createArtifact)
  const createConversation = useStore((s) => s.createConversation)
  const appendToActiveDocumentOrCreate = useStore(
    (s) => s.appendToActiveDocumentOrCreate
  )
  const requestEditorReload = useStore((s) => s.requestEditorReload)
  const setActiveView = useStore((s) => s.setActiveView)
  const artifacts = useStore((s) => s.artifacts)

  const taskRun = useTaskRunContext()

  const [activeId, setActiveId] = useState<string | null>(null)
  // "Generate tasks" (Phase 3) breakdown picker state. `proposed` holds
  // the model's suggested titles awaiting the user's import selection.
  const [generating, setGenerating] = useState(false)
  const [proposed, setProposed] = useState<string[] | null>(null)
  // Phase 5 quick-filter — hides the Done column to focus on what's
  // left. Lightweight (local) since it's a transient view preference.
  const [hideDone, setHideDone] = useState(false)
  // Phase 4 "Run as task". The card optimistically moved to In progress
  // while its runId is still pending (startTask is fire-and-forget; the
  // runId arrives a beat later on the first stream event).
  const [pendingCardId, setPendingCardId] = useState<string | null>(null)
  // Guards the terminal-edge handler so a card is settled once per run
  // even though `view` updates on every token. Holds the last runId we
  // already settled.
  const settledRunRef = useRef<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  // Stamp the runId onto the launched card once it arrives (so the card
  // re-attaches to the run across reloads via `taskId`), or revert the
  // optimistic move if the start failed before producing a runId.
  const runId = taskRun.runId
  const runError = taskRun.error
  useEffect(() => {
    if (!pendingCardId) return
    if (runId) {
      updateProjectTask(pendingCardId, { taskId: runId })
      setPendingCardId(null)
    } else if (runError) {
      moveProjectTask(pendingCardId, "todo", 0)
      setPendingCardId(null)
      toast.error("Couldn't start the task.")
    }
  }, [pendingCardId, runId, runError, updateProjectTask, moveProjectTask])

  // Observe the active run's status and drive its card: on `done`, move
  // it to Done and link the result as a markdown artifact; on
  // `failed`/`cancelled`, move it back to To-do. Keyed by runId so a
  // resumed-on-reload run (whose card is matched by `taskId`) settles
  // correctly too.
  const status = taskRun.view.status
  const resultText = taskRun.view.resultText
  const streamedText = taskRun.view.text
  useEffect(() => {
    if (!runId) return
    if (status !== "done" && status !== "failed" && status !== "cancelled") {
      return
    }
    if (settledRunRef.current === runId) return
    const card = useStore.getState().projectTasks.find((t) => t.taskId === runId)
    if (!card) return
    settledRunRef.current = runId

    if (status === "done") {
      if (!card.artifactId) {
        const text = (resultText ?? streamedText).trim()
        const convId =
          taskRun.runConversationId ?? useStore.getState().activeConversationId
        if (text && convId) {
          const artifact = createArtifact({
            conversationId: convId,
            kind: "markdown",
            title: card.title,
            content: text,
          })
          updateProjectTask(card.id, { artifactId: artifact.id })
        }
      }
      moveProjectTask(card.id, "done", 0)
    } else {
      moveProjectTask(card.id, "todo", 0)
      if (status === "failed") {
        toast.error("Task failed — card moved back to To-do.")
      }
    }
  }, [
    runId,
    status,
    resultText,
    streamedText,
    taskRun.runConversationId,
    createArtifact,
    updateProjectTask,
    moveProjectTask,
  ])

  // Launch a long-running task for a card: workspace system prompt +
  // skills cascade + the card title as the goal. The result lands as an
  // assistant message in the workspace's conversation (authored by the
  // task runner) and, on the board, as a linked markdown artifact.
  const runCard = (card: ProjectTask) => {
    if (!workspace || taskRun.isRunning || pendingCardId) return
    const state = useStore.getState()
    const active = state.conversations.find(
      (c) => c.id === state.activeConversationId
    )
    const conversationId =
      active && active.workspaceId === workspace.id
        ? active.id
        : createConversation(workspace.id).id

    const body: TaskRequestInput = {
      messages: [{ role: "user", content: card.title }],
      conversationId,
      model: workspace.defaultModel,
      workspaceSystemPrompt: workspace.systemPrompt?.trim() || undefined,
      workspaceId: workspace.id,
      skills: resolveEnabledSkills({ workspace }),
    }
    settledRunRef.current = null
    setPendingCardId(card.id)
    moveProjectTask(card.id, "in_progress", 0)
    taskRun.startTask(body, { title: card.title })
  }

  // Send a card's linked artifact to the editor (Phase 4 deliverable
  // surface). Mirrors the artifacts tab's "Send to editor".
  const viewResult = (card: ProjectTask) => {
    const artifact = card.artifactId
      ? artifacts.find((a) => a.id === card.artifactId)
      : undefined
    if (!artifact) {
      toast.error("This task's result is no longer available.")
      return
    }
    appendToActiveDocumentOrCreate(artifact.content)
    requestEditorReload()
    setActiveView("editor")
    toast.success("Sent result to editor")
  }

  const run: CardRunInfo = {
    activeRunId: runId,
    pendingCardId,
    running: taskRun.isRunning,
    step: taskRun.view.step,
    maxSteps: taskRun.view.maxSteps,
  }

  // Cards grouped per column, memoised so drag re-renders stay cheap.
  const byColumn = useMemo(() => {
    const out = {} as Record<ProjectTaskStatus, ProjectTask[]>
    for (const status of PROJECT_TASK_COLUMNS) {
      out[status] = columnTasks(tasks, status)
    }
    return out
  }, [tasks])

  const activeTask = activeId ? tasks.find((t) => t.id === activeId) ?? null : null

  const goal = workspace?.goal?.trim() ?? ""

  // Phase 5 — Markdown export. All inputs come from the store; no
  // network roundtrip. Filename mirrors conversation export.
  const exportProject = () => {
    if (!workspace) return
    const md = projectToMarkdown(workspace, tasks, artifacts)
    downloadAsFile(`${safeFilename(workspace.name)}-project.md`, md)
    toast.success("Project exported")
  }

  const generateTasks = async () => {
    if (!workspace || !goal || generating) return
    setGenerating(true)
    try {
      const res = await apiClient.summarize.projectBreakdown({
        mode: "project-breakdown",
        goal,
        existingTitles: tasks.map((t) => t.title),
      })
      if (!res || res.titles.length === 0) {
        toast.error("Couldn't generate tasks. Try again or refine the goal.")
        return
      }
      setProposed(res.titles)
    } finally {
      setGenerating(false)
    }
  }

  if (!workspace?.isProject) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-xs text-[var(--muted-foreground)]">
        Project mode is off for this workspace. Enable it in workspace
        settings to use the task board.
      </div>
    )
  }

  // Resolve the destination column for a drop. `over.id` is either a
  // column id (dropped on empty column space) or a card id (dropped on
  // another card — adopt that card's column + index).
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = e
    if (!over) return
    const taskId = String(active.id)
    const moving = tasks.find((t) => t.id === taskId)
    if (!moving) return

    const overId = String(over.id)
    const overColumn = PROJECT_TASK_COLUMNS.find((c) => c === overId)
    if (overColumn) {
      // Dropped on the column itself → append to the tail.
      moveProjectTask(taskId, overColumn, byColumn[overColumn].length)
      return
    }
    const overTask = tasks.find((t) => t.id === overId)
    if (!overTask) return
    const destStatus = overTask.status as ProjectTaskStatus
    const destIndex = byColumn[destStatus].findIndex((t) => t.id === overId)
    moveProjectTask(taskId, destStatus, destIndex < 0 ? 0 : destIndex)
  }

  const progress = projectProgress(tasks)
  const milestones = workspace.milestones ?? []
  const visibleColumns = hideDone
    ? PROJECT_TASK_COLUMNS.filter((c) => c !== "done")
    : PROJECT_TASK_COLUMNS

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 h-11 px-3 border-b border-[var(--border)] flex items-center justify-between gap-2">
        <p className="text-[11px] text-[var(--muted-foreground)] truncate tabular-nums">
          {progress.total === 0
            ? "No tasks yet"
            : `${progress.done}/${progress.total} done`}
        </p>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setHideDone((v) => !v)}
            disabled={progress.total === 0}
            aria-label={hideDone ? "Show done column" : "Hide done column"}
            title={hideDone ? "Show done column" : "Hide done column"}
            className="h-7 w-7 grid place-items-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/50 disabled:opacity-40"
          >
            {hideDone ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            type="button"
            onClick={exportProject}
            disabled={progress.total === 0 && !goal && milestones.length === 0}
            aria-label="Export project as Markdown"
            title="Export project as Markdown"
            className="h-7 w-7 grid place-items-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/50 disabled:opacity-40"
          >
            <Download size={13} />
          </button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={generateTasks}
            disabled={!goal || generating}
            title={
              goal
                ? "Break the project goal into tasks"
                : "Set a project goal in workspace settings first"
            }
            className="h-7 px-2 gap-1.5 text-[11px]"
          >
            {generating ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            Generate tasks
          </Button>
        </div>
      </div>

      {(progress.total > 0 || milestones.length > 0) && (
        <div className="shrink-0 px-3 py-2 border-b border-[var(--border)] space-y-1.5">
          {progress.total > 0 && (
            <div
              className="h-1 rounded bg-[var(--muted)]/40 overflow-hidden"
              role="progressbar"
              aria-valuenow={progress.done}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-label="Project progress"
            >
              <div
                className="h-full bg-[var(--primary)] transition-all"
                style={{
                  width: `${(progress.done / progress.total) * 100}%`,
                }}
              />
            </div>
          )}
          {milestones.length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[var(--muted-foreground)]">
              {milestones.map((m, i) => (
                <li key={i} className="truncate">
                  • {m.title}
                  {m.dueDate && (
                    <span className="ml-1 tabular-nums opacity-70">
                      ({m.dueDate})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {proposed && (
        <BreakdownPicker
          titles={proposed}
          onCancel={() => setProposed(null)}
          onImport={(picked) => {
            picked.forEach((title) =>
              createProjectTask({ workspaceId: workspace.id, title })
            )
            setProposed(null)
            toast.success(
              `Added ${picked.length} task${picked.length === 1 ? "" : "s"}`
            )
          }}
        />
      )}

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          {visibleColumns.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={byColumn[status]}
              run={run}
              onRun={runCard}
              onViewResult={viewResult}
              onAdd={
                status === "todo"
                  ? (title) => createProjectTask({ workspaceId: workspace.id, title })
                  : undefined
              }
            />
          ))}
          <DragOverlay>
            {activeTask ? <CardShell task={activeTask} dragging /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  )
}

/**
 * The "Generate tasks" results panel — model-proposed titles with
 * checkboxes; the user picks which to import as To-do cards. All start
 * checked (the common case is "take them all").
 */
function BreakdownPicker({
  titles,
  onImport,
  onCancel,
}: {
  titles: string[]
  onImport: (picked: string[]) => void
  onCancel: () => void
}) {
  const [checked, setChecked] = useState<boolean[]>(() => titles.map(() => true))
  const pickedCount = checked.filter(Boolean).length

  return (
    <div className="shrink-0 mx-2 mt-2 rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/5 p-2">
      <p className="text-[11px] font-medium text-[var(--foreground)] mb-1.5 px-0.5">
        Proposed tasks — pick which to add
      </p>
      <div className="space-y-0.5 max-h-48 overflow-y-auto">
        {titles.map((title, i) => (
          <label
            key={i}
            className="flex items-start gap-2 px-1 py-1 rounded hover:bg-[var(--accent)]/40 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={checked[i]}
              onChange={(e) =>
                setChecked((prev) => {
                  const next = [...prev]
                  next[i] = e.target.checked
                  return next
                })
              }
              className="mt-0.5 shrink-0 accent-[var(--primary)]"
            />
            <span className="text-xs leading-snug">{title}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1.5 mt-2">
        <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 text-xs">
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={pickedCount === 0}
          onClick={() => onImport(titles.filter((_, i) => checked[i]))}
          className="h-7 text-xs gap-1.5"
        >
          <Plus size={13} />
          Add {pickedCount > 0 ? pickedCount : ""}
        </Button>
      </div>
    </div>
  )
}

function Column({
  status,
  tasks,
  run,
  onRun,
  onViewResult,
  onAdd,
}: {
  status: ProjectTaskStatus
  tasks: ProjectTask[]
  run: CardRunInfo
  onRun: (task: ProjectTask) => void
  onViewResult: (task: ProjectTask) => void
  onAdd?: (title: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const [draft, setDraft] = useState("")

  const submit = () => {
    const title = draft.trim()
    if (!title || !onAdd) return
    onAdd(title)
    setDraft("")
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md border border-[var(--border)] bg-[var(--muted)]/20 p-2",
        isOver && "ring-1 ring-[var(--primary)]/40"
      )}
    >
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-[10px] uppercase tracking-wide font-medium text-[var(--muted-foreground)]">
          {COLUMN_LABELS[status]}
        </span>
        <span className="text-[10px] tabular-nums text-[var(--muted-foreground)]/70">
          {tasks.length}
        </span>
      </div>

      <SortableContext
        items={tasks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-1.5 min-h-[8px]">
          {tasks.map((t) => (
            <SortableCard
              key={t.id}
              task={t}
              run={run}
              onRun={onRun}
              onViewResult={onViewResult}
            />
          ))}
        </div>
      </SortableContext>

      {onAdd && (
        <div className="mt-1.5 flex items-center gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="Add a task"
            className="flex-1 min-w-0 bg-transparent text-xs px-1.5 py-1 rounded border border-transparent focus:border-[var(--border)] outline-none placeholder:text-[var(--muted-foreground)]/60"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            aria-label="Add task"
            className="shrink-0 p-1 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/50 disabled:opacity-40"
          >
            <Plus size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

function SortableCard({
  task,
  run,
  onRun,
  onViewResult,
}: {
  task: ProjectTask
  run: CardRunInfo
  onRun: (task: ProjectTask) => void
  onViewResult: (task: ProjectTask) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      <CardShell
        task={task}
        run={run}
        onRun={onRun}
        onViewResult={onViewResult}
      />
    </div>
  )
}

function CardShell({
  task,
  run,
  onRun,
  onViewResult,
  dragging,
}: {
  task: ProjectTask
  run?: CardRunInfo
  onRun?: (task: ProjectTask) => void
  onViewResult?: (task: ProjectTask) => void
  dragging?: boolean
}) {
  const deleteProjectTask = useStore((s) => s.deleteProjectTask)
  // This card is the one actively running iff its runId matches the
  // active run, or it's the just-launched card whose runId hasn't
  // arrived yet.
  const isRunning =
    !!run?.running &&
    ((!!task.taskId && task.taskId === run.activeRunId) ||
      task.id === run.pendingCardId)
  const canRun =
    !dragging &&
    !!onRun &&
    task.status === "todo" &&
    !isRunning &&
    !run?.running
  const canViewResult = !dragging && !!onViewResult && !!task.artifactId

  return (
    <div
      className={cn(
        "group/card relative rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5",
        "text-xs cursor-grab active:cursor-grabbing",
        dragging && "shadow-lg"
      )}
    >
      <p className="pr-5 leading-snug break-words">{task.title}</p>

      {isRunning && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
          <Loader2 size={11} className="animate-spin" />
          <span className="tabular-nums">
            {run && run.maxSteps
              ? `Step ${run.step}/${run.maxSteps}`
              : run && run.step > 0
                ? `Step ${run.step}`
                : "Working…"}
          </span>
        </div>
      )}

      {(canRun || canViewResult) && (
        <div className="mt-1 flex items-center gap-2">
          {canRun && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onRun?.(task)}
              className="flex items-center gap-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <Play size={11} />
              Run as task
            </button>
          )}
          {canViewResult && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onViewResult?.(task)}
              className="flex items-center gap-1 text-[10px] text-[var(--primary)] hover:underline"
            >
              <ExternalLink size={11} />
              View result
            </button>
          )}
        </div>
      )}

      {!dragging && !isRunning && (
        <button
          type="button"
          // stop dnd listeners on the parent from swallowing the click.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => deleteProjectTask(task.id)}
          aria-label="Delete task"
          className="absolute top-1 right-1 p-0.5 rounded text-[var(--muted-foreground)] opacity-0 group-hover/card:opacity-100 hover:text-[var(--destructive)] transition-opacity"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
