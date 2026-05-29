"use client"

import "client-only"

import { useMemo, useState } from "react"
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
import { Loader2, Play, Plus, Sparkles, X } from "lucide-react"
import { toast } from "sonner"

import {
  useActiveWorkspace,
  useStore,
  useWorkspaceProjectTasks,
} from "@/client/hooks/use-store"
import { apiClient } from "@/client/api-client"
import { useProjectTaskRun } from "@/client/hooks/use-project-task-run"
import { columnTasks, PROJECT_TASK_COLUMNS } from "@/shared/project-tasks"
import type { ProjectTask, ProjectTaskStatus } from "@/shared/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/shared/utils"

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

  const [activeId, setActiveId] = useState<string | null>(null)
  // "Generate tasks" (Phase 3) breakdown picker state. `proposed` holds
  // the model's suggested titles awaiting the user's import selection.
  const [generating, setGenerating] = useState(false)
  const [proposed, setProposed] = useState<string[] | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

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

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 h-11 px-3 border-b border-[var(--border)] flex items-center justify-between gap-2">
        <p className="text-[11px] text-[var(--muted-foreground)] truncate">
          {tasks.length === 0
            ? "No tasks yet"
            : `${byColumn.done.length}/${tasks.filter((t) => t.status !== "cancelled").length} done`}
        </p>
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
          className="h-7 px-2 gap-1.5 shrink-0 text-[11px]"
        >
          {generating ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          Generate tasks
        </Button>
      </div>

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
          {PROJECT_TASK_COLUMNS.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={byColumn[status]}
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
  onAdd,
}: {
  status: ProjectTaskStatus
  tasks: ProjectTask[]
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
            <SortableCard key={t.id} task={t} />
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

function SortableCard({ task }: { task: ProjectTask }) {
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
      <CardShell task={task} />
    </div>
  )
}

function CardShell({
  task,
  dragging,
}: {
  task: ProjectTask
  dragging?: boolean
}) {
  const deleteProjectTask = useStore((s) => s.deleteProjectTask)
  const workspace = useActiveWorkspace()
  // Phase 4 — kick off a long-running agent task using the card title
  // as the goal. The hook also watches an attached run via Realtime
  // and auto-transitions the card when it settles.
  const run = useProjectTaskRun(task, workspace ?? undefined)

  const canLaunch =
    !dragging &&
    !task.taskId &&
    (task.status === "todo" || task.status === "cancelled")
  const runActive = !!task.taskId && task.status === "in_progress"
  const stepLabel = runActive
    ? `step ${run.view.step}${run.view.maxSteps ? ` / ${run.view.maxSteps}` : ""}`
    : null

  return (
    <div
      className={cn(
        "group/card relative rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5",
        "text-xs cursor-grab active:cursor-grabbing",
        dragging && "shadow-lg"
      )}
    >
      <p
        className={cn(
          "pr-5 leading-snug break-words",
          task.status === "done" && "text-[var(--muted-foreground)] line-through",
          task.status === "cancelled" && "text-[var(--muted-foreground)] italic"
        )}
      >
        {task.title}
      </p>
      {runActive && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
          <Loader2 size={10} className="animate-spin text-[var(--primary)]" />
          <span>Running · {stepLabel}</span>
        </div>
      )}
      {run.error && !runActive && (
        <p className="mt-1 text-[10px] text-[var(--destructive)] break-words">
          {run.error}
        </p>
      )}
      {!dragging && (
        <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 transition-opacity">
          {canLaunch && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void run.launch()}
              disabled={run.starting}
              aria-label="Run as task"
              title="Run as task"
              className="p-0.5 rounded text-[var(--muted-foreground)] hover:text-[var(--primary)] disabled:opacity-50"
            >
              {run.starting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} />
              )}
            </button>
          )}
          <button
            type="button"
            // stop dnd listeners on the parent from swallowing the click.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => deleteProjectTask(task.id)}
            aria-label="Delete task"
            className="p-0.5 rounded text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
