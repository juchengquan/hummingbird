import "client-only"

/**
 * What `TaskRunProvider` does with the saved pointer to a task started the
 * old way (`humm.activeTask.<userId>`, `./active-task.ts`).
 *
 * Off runs (`ts`, `python`, `ts-service` until wave 13) the old path
 * watches it through `/api/tasks/:id/stream`, as before. On "agent-py
 * (runs)" it is followed through `/v1/runs` instead (Q126): it is the same
 * `tasks` row (a background run) the runs list already shows, watches,
 * answers, cancels and delivers, so the provider only opens the panel on
 * it and drops the pointer once the list shows the task ended. Nothing is
 * migrated, and nothing on runs reads an `/api/tasks` route.
 */

import { isTerminalStatus } from "@/shared/agent/events"
import type { ActiveTaskRecord } from "@/shared/agent/active-task"
import type { TaskError, TaskSummary, TasksAvailability } from "@/client/runs/tasks/types"

/**
 * - `none` — nothing to follow here (no pointer, or signed out);
 * - `wait` — the session isn't read yet, so the backend isn't known;
 * - `clear` — this browser already saw it end;
 * - `old_path` — watch it through `/api/tasks` (off runs);
 * - `runs` — the runs list has it (`runsHandOff`).
 */
export type PointerPlan = "none" | "wait" | "clear" | "old_path" | "runs"

/** Which path follows a live pointer here, whatever the pointer. */
export function pathOf(availability: TasksAvailability): Exclude<PointerPlan, "clear"> {
  if (availability.ok) return "runs"
  switch (availability.reason) {
    case "loading":
      return "wait"
    case "signed_out":
      return "none"
    case "not_runs":
      return "old_path"
  }
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
 * On runs, the pointer's task as the runs list has it: `wait` until a list
 * read succeeded; `focus` (open the panel on it) while it is live; `clear`
 * once it ended — the list delivers its result under the task's derived
 * ids (Q70), a no-op if the old path already wrote it — or when it isn't
 * listed (deleted, or another account's).
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
