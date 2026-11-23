"use client"
import "client-only"

import type { ChildRuns } from "@/client/agent/use-child-runs"
import type { RunStatus } from "@/shared/agent/events"
import type { TaskRunView } from "@/shared/agent/project"

export interface TaskProgress {
  /** The Tasks panel's status line, and the board card's. */
  label: string
  /** The one-line pointer in the chat thread. */
  pointer: string
  /** It waits for the user: nothing spins. */
  paused: boolean
}

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  cancelled: "Cancelled",
  done: "Done",
  failed: "Failed",
}

/**
 * What a live task is doing, for the surfaces that show it. A parent
 * waiting on its sub-agents has no `paused` in its own log (the spawn
 * writes none), so that comes from its children's rows.
 */
export function taskProgress(
  view: TaskRunView,
  children?: Pick<ChildRuns, "asking" | "waiting">
): TaskProgress {
  if (view.pendingInput) {
    return { label: "Paused · needs your answer", pointer: "Task needs your answer", paused: true }
  }
  const asking = children?.asking.length ?? 0
  if (asking > 0) {
    const label =
      asking === 1 ? "A sub-agent needs your answer" : `${asking} sub-agents need your answer`
    return { label, pointer: label, paused: true }
  }
  if (view.status === "paused") {
    return { label: STATUS_LABEL.paused, pointer: "Task paused", paused: true }
  }
  if (children?.waiting) {
    return { label: "Waiting on sub-agents", pointer: "Task waiting on sub-agents", paused: false }
  }
  const pointer =
    view.status === "queued"
      ? "Task queued · waiting for worker"
      : `Task running · step ${view.step}${view.maxSteps ? ` / ${view.maxSteps}` : ""}`
  return { label: STATUS_LABEL[view.status], pointer, paused: false }
}
