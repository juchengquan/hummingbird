"use client"
import "client-only"

/**
 * How every launch point starts a task on runs (the Task toggle,
 * `/research`, a resend of a task turn, the board's "Run as task"):
 *
 * - signed out → refused here, nothing sent (background runs are
 *   `401 auth_required`, bug 20);
 * - at the cap (Q72) → refused here, said plainly; the server refuses a
 *   race past it with `409 limit_reached`, said the same way;
 * - waits for the sync queue to drain first, so the conversation the
 *   task belongs to — often just created — is on the server before the
 *   run that names it (bug 5: `404 not_found`);
 * - shows a refusal, or opens the Tasks panel on the new task.
 */

import { toast } from "sonner"

import { whenDrained } from "@/client/sync/sync-queue"
import type {
  TaskLaunchOptions,
  TaskLaunchResult,
  TasksContextValue,
} from "@/client/runs/tasks/types"
import type { TaskRequestInput } from "@/shared/api-schemas"

import { useTaskFocus } from "./focus"
import { launchRefusalText } from "./phase"

/** How long a launch waits for its conversation to sync. */
const SYNC_WAIT_MS = 20_000

/** Whether the tasks interface launches on runs (else the old path does). */
export function launchesOnRuns(tasks: Pick<TasksContextValue, "availability">): boolean {
  return tasks.availability.ok || tasks.availability.reason === "signed_out"
}

/** A refusal before anything is sent, or null when a launch may go. */
export function preLaunchRefusal(
  tasks: Pick<TasksContextValue, "availability" | "activeCount" | "activeLimit">,
): { code: string; text: string } | null {
  if (tasks.availability.ok === false && tasks.availability.reason === "signed_out") {
    return { code: "auth_required", text: launchRefusalText("auth_required", "", tasks.activeLimit) }
  }
  if (tasks.activeCount >= tasks.activeLimit) {
    return { code: "limit_reached", text: launchRefusalText("limit_reached", "", tasks.activeLimit) }
  }
  return null
}

export async function launchTaskOnRuns(
  tasks: TasksContextValue,
  input: TaskRequestInput,
  opts?: TaskLaunchOptions,
): Promise<TaskLaunchResult> {
  const refused = preLaunchRefusal(tasks)
  if (refused) {
    toast.error(refused.text)
    return { ok: false, code: refused.code, message: refused.text }
  }
  await whenDrained(SYNC_WAIT_MS)
  let result: TaskLaunchResult
  try {
    result = await tasks.launch(input, opts)
  } catch (err) {
    result = { ok: false, code: "network", message: (err as Error).message }
  }
  if (result.ok) useTaskFocus.getState().focus(result.rootRunId)
  else toast.error(launchRefusalText(result.code, result.message, tasks.activeLimit))
  return result
}
