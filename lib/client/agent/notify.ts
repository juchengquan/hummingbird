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

function hiddenAndGranted(): boolean {
  if (!supported() || Notification.permission !== "granted") return false
  return !(typeof document !== "undefined" && document.visibilityState === "visible")
}

/** One tag per task, so one task's notification never replaces another's
 *  (survey bug 3). */
function tagFor(runId: string | undefined): string {
  return runId ? `humm-task-${runId}` : "humm-task"
}

/**
 * Fire a notification for a settled run — finished or failed (a cancel is
 * the user's own doing). No-ops when the tab is still focused (the user
 * can see the strip), when permission isn't granted, or when the API is
 * unavailable.
 */
export function notifyTaskFinished(
  view: TaskRunView,
  opts?: { title?: string; runId?: string }
): void {
  if (view.status !== "done" && view.status !== "failed") return
  if (!hiddenAndGranted()) return
  const heading = view.status === "done" ? "Task finished" : "Task failed"
  const context = opts?.title ? ` · ${opts.title}` : ""
  const preview = (
    view.status === "failed" ? (view.fatalError ?? "") : (view.resultText ?? view.text ?? "")
  )
    .trim()
    .slice(0, 80)
  try {
    new Notification(`${heading}${context}`, {
      body: preview || undefined,
      tag: tagFor(opts?.runId),
    })
  } catch {
    // Some browsers throw if invoked outside a SW for certain options.
  }
}

const ASKED_KEY = "humm.notifiedQuestions"
const ASKED_MAX = 200

/**
 * Notify that a task waits on the user (Q74), once per question across
 * this browser's tabs (a mark in localStorage, written by whichever tab
 * sees the question first — a visible tab marks it without showing).
 */
export function notifyTaskNeedsAnswer(
  runId: string,
  requestId: string,
  opts?: { title?: string; prompt?: string }
): void {
  const key = `${runId}:${requestId}`
  let asked: string[] = []
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ASKED_KEY) ?? "[]")
    asked = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
    if (asked.includes(key)) return
    localStorage.setItem(ASKED_KEY, JSON.stringify([...asked, key].slice(-ASKED_MAX)))
  } catch {
    // No storage: notify at most once per tab session below.
  }
  if (!hiddenAndGranted()) return
  try {
    new Notification(`Task needs your answer${opts?.title ? ` · ${opts.title}` : ""}`, {
      body: opts?.prompt?.slice(0, 120) || undefined,
      tag: tagFor(runId),
    })
  } catch {
    // ignore
  }
}
