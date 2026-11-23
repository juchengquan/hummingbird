/**
 * What the runs task list says about a task (wave 6, Q69): its badge,
 * the status icon it shares with the old strip, its sub-agents' pills and
 * the refusals a launch or an answer can meet. Pure.
 */

import type { RunStatus as StripStatus } from "@/shared/agent/events"
import { stepLimitNote, stoppedAtStepLimit } from "@/shared/agent/step-limit"

import type {
  TaskChild,
  TaskPhase,
  TaskSummary,
} from "@/client/runs/tasks/types"

/** A task still counting against the cap (Q72). */
export const ACTIVE_PHASES: ReadonlySet<TaskPhase> = new Set([
  "launching",
  "queued",
  "running",
  "needs_answer",
  "answer_sent",
])

export function isActivePhase(phase: TaskPhase): boolean {
  return ACTIVE_PHASES.has(phase)
}

/** The old strip's status for the shared icon. */
export function stripStatus(phase: TaskPhase): StripStatus {
  switch (phase) {
    case "launching":
    case "queued":
      return "queued"
    case "running":
      return "running"
    case "needs_answer":
    case "answer_sent":
      return "paused"
    case "succeeded":
      return "done"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
  }
}

/** The task's badge in the list (and the board card's line). */
export function phaseLabel(task: Pick<TaskSummary, "phase" | "step" | "maxSteps" | "childrenAsking" | "questions">): string {
  switch (task.phase) {
    case "launching":
      return "Starting…"
    case "queued":
      return "Queued · waiting for a worker"
    case "running":
      return task.step !== null && task.step > 0
        ? `Running · step ${task.step}${task.maxSteps ? ` / ${task.maxSteps}` : ""}`
        : "Running"
    case "needs_answer": {
      const own = task.questions.filter((q) => q.answeredBy === "resume").length
      const children = Math.max(
        task.childrenAsking,
        task.questions.filter((q) => q.answeredBy === "in_place").length,
      )
      if (own === 0 && children === 1) return "A sub-agent needs your answer"
      if (own === 0 && children > 1) return `${children} sub-agents need your answer`
      return "Needs your answer"
    }
    case "answer_sent":
      return "Answer sent · waiting for the task to continue"
    case "succeeded":
      return "Finished"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
  }
}

/** The one-line pointer in the chat thread for a task of this conversation. */
export function pointerLabel(task: TaskSummary): string {
  switch (task.phase) {
    case "needs_answer":
      return phaseLabel(task) === "Needs your answer" ? "Task needs your answer" : phaseLabel(task)
    case "running":
      return `Task ${phaseLabel(task).toLowerCase()}`
    case "queued":
      return "Task queued · waiting for worker"
    case "launching":
      return "Starting the task…"
    case "answer_sent":
      return "Answer sent · task continuing"
    default:
      return `Task ${phaseLabel(task).toLowerCase()}`
  }
}

/** Q81: the note a succeeded task carries when it stopped at its step
 *  limit, else null. */
export function stepLimitNoteFor(task: Pick<TaskSummary, "phase" | "result" | "maxSteps">): string | null {
  return task.phase === "succeeded" && stoppedAtStepLimit(task.result)
    ? stepLimitNote(task.maxSteps)
    : null
}

/** A sub-agent's pill. A cancelled sub-agent was skipped (Q60). */
export function childPill(child: Pick<TaskChild, "status" | "question">): string {
  if (child.question?.answerPending) return "answer sent"
  switch (child.status) {
    case "interrupted":
      return "asking"
    case "succeeded":
      return "done"
    case "cancelled":
      return "skipped"
    default:
      return child.status
  }
}

export function childCanSkip(child: Pick<TaskChild, "status">): boolean {
  return child.status === "queued" || child.status === "running" || child.status === "interrupted"
}

/** A refused launch, said plainly (Q72: `limit_reached`). */
export function launchRefusalText(code: string, message: string, limit: number): string {
  switch (code) {
    case "limit_reached":
      return `You already have ${limit} tasks running. Wait for one to finish, or cancel one, then try again.`
    case "auth_required":
    case "auth":
      return "Sign in to run tasks."
    case "not_found":
      return "This conversation hasn't synced yet. Try again in a moment."
    case "unknown_model":
      return `Tasks can't run this model. ${message}`.trim()
    default:
      return message ? `Couldn't start the task: ${message}` : "Couldn't start the task."
  }
}

/** A refused answer, said plainly. `stale`: the question moved on, so
 *  the card should go (the list re-reads the task). */
export function answerRefusal(code: string, message: string): { text: string; stale: boolean } {
  switch (code) {
    case "run_already_resumed":
    case "run_already_answered":
      return { text: "This question was answered elsewhere.", stale: true }
    case "run_answer_applied":
      return {
        text: "An earlier answer to this question was already acted on, and the task failed. Run it again as a new task.",
        stale: true,
      }
    case "invalid_state":
      return { text: "This question is no longer open: the task was cancelled or ended.", stale: true }
    case "limit_reached":
      return { text: "Too many answers are waiting for a worker. Try again shortly.", stale: false }
    default:
      return { text: message ? `Couldn't send your answer: ${message}` : "Couldn't send your answer.", stale: false }
  }
}

/** The cap line at the top of the list. */
export function capLabel(active: number, limit: number): string {
  return `${active} of ${limit} running`
}
