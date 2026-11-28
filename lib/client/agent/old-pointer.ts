import "client-only"

/**
 * What `OldTaskPointerHandOff` does with the saved pointer to a task
 * started the old way (`humm.activeTask.<userId>`, `./active-task.ts`,
 * written by the `/api/tasks` path before wave 13).
 *
 * It is followed through `/v1/runs` (Q126): it is the same `tasks` row (a
 * background run) the runs list already shows, watches, answers, cancels
 * and delivers, so the hand-off only opens the panel on it and drops the
 * pointer once the list shows the task ended. Nothing is migrated, and
 * nothing reads an `/api/tasks` route.
 */

import { isTerminalStatus } from "@/shared/agent/events"
import type { ActiveTaskRecord } from "@/shared/agent/active-task"
import type { TaskError, TaskSummary, TasksAvailability } from "@/client/runs/tasks/types"

/**
 * - `none` — nothing to follow here (no pointer, or signed out);
 * - `wait` — the session isn't read yet;
 * - `clear` — this browser already saw it end;
 * - `runs` — the runs list has it (`runsHandOff`).
 */
export type PointerPlan = "none" | "wait" | "clear" | "runs"

/** What follows a live pointer here, whatever the pointer. */
function pathOf(availability: TasksAvailability): Exclude<PointerPlan, "clear"> {
  if (availability.ok) return "runs"
  return availability.reason === "loading" ? "wait" : "none"
}

export function pointerPlan(
  pointer: Pick<ActiveTaskRecord, "runId" | "status"> | null,
  availability: TasksAvailability,
): PointerPlan {
  if (!pointer) return "none"
  if (isTerminalStatus(pointer.status)) return "clear"
  return pathOf(availability)
}

const ENDED: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"])

/**
 * The pointer's task as the runs list has it: `wait` until a list read
 * succeeded; `focus` (open the panel on it) while it is live; `clear` once
 * it ended — the list delivers its result under the task's derived ids
 * (Q70), a no-op if the old path already wrote it — or when it isn't listed
 * (deleted, or another account's).
 */
export function runsHandOff(
  pointer: Pick<ActiveTaskRecord, "runId">,
  list: { tasks: readonly Pick<TaskSummary, "rootRunId" | "phase">[] | null; listError: TaskError | null },
): "wait" | "focus" | "clear" {
  if (list.tasks === null || list.listError) return "wait"
  const task = list.tasks.find((t) => t.rootRunId === pointer.runId)
  if (!task || ENDED.has(task.phase)) return "clear"
  return "focus"
}
