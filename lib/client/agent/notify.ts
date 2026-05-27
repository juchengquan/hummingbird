"use client"
import "client-only"

/**
 * Finish-while-away browser notification for long-running tasks. Best
 * effort throughout: if the Notification API is missing, permission is
 * denied, or the tab is focused, we silently no-op — a missed
 * notification is never worth an error.
 */

import type { TaskRunView } from "@/shared/agent/project"

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window
}

/** Ask for permission if it hasn't been decided yet. Resolves to the
 *  effective permission; never throws. */
export async function ensureTaskNotificationPermission(): Promise<NotificationPermission> {
  if (!supported()) return "denied"
  if (Notification.permission !== "default") return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return "denied"
  }
}

/**
 * Fire a notification for a settled run. No-ops when the tab is still
 * focused (the user can see the strip), when permission isn't granted,
 * or when the API is unavailable.
 */
export function notifyTaskFinished(
  view: TaskRunView,
  opts?: { title?: string }
): void {
  if (!supported() || Notification.permission !== "granted") return
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    return
  }
  const heading =
    view.status === "done"
      ? "Task finished"
      : view.status === "failed"
        ? "Task failed"
        : "Task ended"
  const context = opts?.title ? ` · ${opts.title}` : ""
  const preview = (view.resultText ?? view.text ?? "").trim().slice(0, 80)
  try {
    new Notification(`${heading}${context}`, {
      body: preview || undefined,
      tag: "humm-task",
    })
  } catch {
    // Some browsers throw if invoked outside a SW for certain options.
  }
}
