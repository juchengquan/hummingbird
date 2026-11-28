import "client-only"

/**
 * Task notifications (Q74): when a task needs an answer (its own question
 * or a sub-agent's), fails, or finishes — once per event across this
 * browser's tabs, shown only by a hidden tab.
 *
 * Driven by the list (every read), not by a stream, so a task nobody is
 * watching still notifies. Each event has a key (`taskNotificationKey`:
 * per task and kind, and per question for `needs_answer`); the first tab
 * to see an event takes a Web Lock, checks and writes the mark in
 * `humm.tasks.<userId>`, and shows the notification if it is hidden — a
 * visible tab marks it without showing (the user is looking at the app).
 * Events older than `NOTIFY_WINDOW_MS` are marked silently: opening the
 * app after a week doesn't replay a week of notifications. Each task has
 * its own tag, so one task's notification never replaces another's
 * (survey bug 3).
 */

import type { TaskPointers } from "./pointers"
import { taskNotificationKey, type TaskNotificationKind, type TaskSummary } from "./types"
import type { LockLike } from "./deliver"

/** An event older than this is marked without a notification. */
export const NOTIFY_WINDOW_MS = 10 * 60_000

export interface TaskNotificationEvent {
  key: string
  kind: TaskNotificationKind
  rootRunId: string
  title: string
  body?: string
  /** When it happened (ISO). */
  at: string
}

/** The notifiable events a list row shows. */
export function notificationEvents(task: TaskSummary): TaskNotificationEvent[] {
  const title = task.title || "Task"
  switch (task.phase) {
    case "succeeded":
      return [
        {
          key: taskNotificationKey(task.rootRunId, "done"),
          kind: "done",
          rootRunId: task.rootRunId,
          title,
          body: typeof task.result?.text === "string" ? task.result.text.trim().slice(0, 80) : undefined,
          at: task.finishedAt ?? task.updatedAt,
        },
      ]
    case "failed":
      return [
        {
          key: taskNotificationKey(task.rootRunId, "failed"),
          kind: "failed",
          rootRunId: task.rootRunId,
          title,
          body: task.error?.message,
          at: task.finishedAt ?? task.updatedAt,
        },
      ]
    case "needs_answer":
      return task.questions
        .filter((q) => !q.answerPending)
        .map((q) => ({
          key: taskNotificationKey(task.rootRunId, "needs_answer", {
            runId: q.runId,
            interruptId: q.interrupt.id,
          }),
          kind: "needs_answer" as const,
          rootRunId: task.rootRunId,
          title,
          body: q.interrupt.message ?? (q.interrupt.tool ? `Approve ${q.interrupt.tool}?` : undefined),
          at: task.updatedAt,
        }))
    default:
      return []
  }
}

export interface NotifyDeps {
  userId: string
  pointers: TaskPointers
  locks?: LockLike | null
  now(): number
  /** The tab is hidden (`document.visibilityState`). */
  isHidden(): boolean
  /** Show it (`new Notification`); only called with permission granted. */
  show(title: string, options: { body?: string; tag: string }): void
  /** `Notification.permission`. */
  permission(): NotificationPermission | "unsupported"
}

const HEADINGS: Record<TaskNotificationKind, string> = {
  done: "Task finished",
  failed: "Task failed",
  needs_answer: "Task needs your answer",
}

/** The tag of a task's notifications: one per task (bug 3). */
export function notificationTag(rootRunId: string): string {
  return `humm-task-${rootRunId}`
}

/** Notify one event, once across tabs. Returns whether this tab showed it. */
export async function notifyOnce(event: TaskNotificationEvent, deps: NotifyDeps): Promise<boolean> {
  if (deps.pointers.isNotified(event.key)) return false
  const run = async (): Promise<boolean> => {
    if (deps.pointers.isNotified(event.key)) return false
    deps.pointers.markNotified(event.key)
    const age = deps.now() - Date.parse(event.at)
    if (Number.isFinite(age) && age > NOTIFY_WINDOW_MS) return false
    if (!deps.isHidden() || deps.permission() !== "granted") return false
    try {
      deps.show(`${HEADINGS[event.kind]} · ${event.title}`, {
        ...(event.body ? { body: event.body } : {}),
        tag: notificationTag(event.rootRunId),
      })
      return true
    } catch {
      return false
    }
  }
  return deps.locks ? deps.locks.request(`humm.tasks.notify.${deps.userId}`, run) : run()
}

/** The browser's notification seam. */
export function browserNotifier(): Pick<NotifyDeps, "isHidden" | "show" | "permission"> {
  return {
    isHidden: () => typeof document !== "undefined" && document.visibilityState !== "visible",
    permission: () =>
      typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported",
    show: (title, options) => {
      new Notification(title, options)
    },
  }
}
