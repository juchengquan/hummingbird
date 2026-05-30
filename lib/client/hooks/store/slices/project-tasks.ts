import "client-only"

import type { ProjectTask, ProjectTaskStatus } from "@/shared/types"
import { uuid } from "@/shared/uuid"
import {
  moveProjectTask as moveProjectTaskPure,
  nextPosition,
} from "@/shared/project-tasks"

import { useStore } from "../../use-store"
import type { SliceCreator } from "../types"

/**
 * Project-tasks slice — Kanban cards for project workspaces. Flat array
 * across all workspaces; the board filters by workspaceId. See
 * `docs/_done/PLAN-project-mode.md`. The workspace-delete cascade (in the
 * workspaces slice) prunes a workspace's cards, so this slice owns no
 * cross-entity cascade of its own.
 */
export interface ProjectTasksSlice {
  projectTasks: ProjectTask[]

  // New cards land at the tail of the To-do column. `moveProjectTask`
  // handles drag (reorder + column change) via the pure helper in
  // `lib/shared/project-tasks.ts`.
  createProjectTask: (input: {
    workspaceId: string
    title: string
    status?: ProjectTaskStatus
  }) => ProjectTask
  updateProjectTask: (
    taskId: string,
    patch: Partial<Pick<ProjectTask, "title" | "status" | "taskId" | "artifactId">>
  ) => void
  moveProjectTask: (
    taskId: string,
    toStatus: ProjectTaskStatus,
    toIndex: number
  ) => void
  deleteProjectTask: (taskId: string) => void
}

export const createProjectTasksSlice: SliceCreator<ProjectTasksSlice> = (
  set,
  get
) => ({
  projectTasks: [],

  createProjectTask: ({ workspaceId, title, status = "todo" }) => {
    const now = new Date()
    const task: ProjectTask = {
      id: uuid(),
      workspaceId,
      title,
      status,
      position: nextPosition(
        get().projectTasks.filter((t) => t.workspaceId === workspaceId),
        status
      ),
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({ projectTasks: [...state.projectTasks, task] }))
    return task
  },
  updateProjectTask: (taskId, patch) =>
    set((state) => ({
      projectTasks: state.projectTasks.map((t) =>
        t.id === taskId ? { ...t, ...patch, updatedAt: new Date() } : t
      ),
    })),
  moveProjectTask: (taskId, toStatus, toIndex) =>
    set((state) => {
      const task = state.projectTasks.find((t) => t.id === taskId)
      if (!task) return state
      // Reorder only within the moved card's workspace; merge the
      // result back over the flat cross-workspace array.
      const wsId = task.workspaceId
      const wsTasks = state.projectTasks.filter((t) => t.workspaceId === wsId)
      const reordered = moveProjectTaskPure(
        wsTasks,
        taskId,
        toStatus,
        toIndex,
        new Date()
      )
      if (reordered === wsTasks) return state
      const byId = new Map(reordered.map((t) => [t.id, t]))
      return {
        projectTasks: state.projectTasks.map((t) => byId.get(t.id) ?? t),
      }
    }),
  deleteProjectTask: (taskId) =>
    set((state) => ({
      projectTasks: state.projectTasks.filter((t) => t.id !== taskId),
    })),
})

/** Project-task cards for the active workspace (all columns, unsorted —
 *  the board groups + sorts by column via `columnTasks`). */
export const useWorkspaceProjectTasks = () => {
  const projectTasks = useStore((state) => state.projectTasks)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  if (!activeWorkspaceId) return [] as ProjectTask[]
  return projectTasks.filter((t) => t.workspaceId === activeWorkspaceId)
}
