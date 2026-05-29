import type { ProjectTask, ProjectTaskStatus } from "@/shared/types"

/**
 * Pure board logic for project-mode Kanban cards. Lives in `lib/shared`
 * so the store mutator and any tests share one implementation — same
 * split as `lib/shared/compression.ts`.
 *
 * `position` is a per-(workspace, status) ordering integer. Cards in a
 * column render sorted ascending. Any move renumbers the affected
 * column(s) to a contiguous 0..n so positions never drift or collide.
 */

export const PROJECT_TASK_COLUMNS: ProjectTaskStatus[] = [
  "todo",
  "in_progress",
  "done",
]

/** Cards of one column (workspace already filtered), sorted by position. */
export function columnTasks(
  tasks: ProjectTask[],
  status: ProjectTaskStatus
): ProjectTask[] {
  return tasks
    .filter((t) => t.status === status)
    .sort((a, b) => a.position - b.position)
}

/** Next free position at the tail of a column. */
export function nextPosition(
  tasks: ProjectTask[],
  status: ProjectTaskStatus
): number {
  const col = tasks.filter((t) => t.status === status)
  return col.length === 0 ? 0 : Math.max(...col.map((t) => t.position)) + 1
}

/**
 * Move `taskId` to `toStatus` at `toIndex`, returning a new array for
 * the given workspace with positions renumbered. Both the source and
 * target columns are renumbered contiguously so drag-reorder (same
 * column) and inter-column moves both stay consistent.
 *
 * `tasks` is expected to be a single workspace's cards. Unknown
 * `taskId` returns the input unchanged. `now` stamps `updatedAt` on
 * every card whose position or status actually changed.
 */
export function moveProjectTask(
  tasks: ProjectTask[],
  taskId: string,
  toStatus: ProjectTaskStatus,
  toIndex: number,
  now: Date
): ProjectTask[] {
  const moving = tasks.find((t) => t.id === taskId)
  if (!moving) return tasks

  const fromStatus = moving.status
  // Target column as it stands, minus the moving card (in case it's an
  // intra-column reorder), in current visual order.
  const target = columnTasks(tasks, toStatus).filter((t) => t.id !== taskId)
  const clampedIndex = Math.max(0, Math.min(toIndex, target.length))
  target.splice(clampedIndex, 0, { ...moving, status: toStatus })

  // Renumber the target column; if the move crossed columns, also
  // renumber the source column (its remaining cards close the gap).
  const renumbered = new Map<string, ProjectTask>()
  target.forEach((t, i) => {
    const orig = tasks.find((x) => x.id === t.id)!
    if (orig.position !== i || orig.status !== toStatus) {
      renumbered.set(t.id, { ...orig, status: toStatus, position: i, updatedAt: now })
    }
  })
  if (fromStatus !== toStatus) {
    columnTasks(tasks, fromStatus)
      .filter((t) => t.id !== taskId)
      .forEach((t, i) => {
        if (t.position !== i) {
          renumbered.set(t.id, { ...t, position: i, updatedAt: now })
        }
      })
  }

  if (renumbered.size === 0) return tasks
  return tasks.map((t) => renumbered.get(t.id) ?? t)
}
