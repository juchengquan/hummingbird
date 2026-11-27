"use client"
import "client-only"

/**
 * Browser-notification permission for long-running tasks, asked on the
 * gesture that opts in (Q74). The notifications themselves are the tasks
 * interface's (`lib/client/runs/tasks/notify.ts`). Best effort: if the
 * Notification API is missing or permission is denied, nothing throws.
 */

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
