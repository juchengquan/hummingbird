import "client-only"

/**
 * A task as the list shows it, from its current run's `Run` (the list
 * reads `listRuns?mode=background&topLevel=true&current=true`), and the
 * list's order. Pure.
 */

import type { RunStatus as EventRunStatus } from "@/shared/agent/events"
import { resultIdsFor } from "@/shared/runs/ids"

import { toPendingInterrupt } from "../interrupts"
import type { Interrupt, Run, RunStatus } from "../types"
import type { LaunchingTask, TaskChild, TaskError, TaskPhase, TaskQuestion, TaskSummary } from "./types"

/** The phases that count against the cap (Q72): everything not ended. */
export const ACTIVE_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  "launching",
  "queued",
  "running",
  "needs_answer",
  "answer_sent",
])

export const ENDED_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["succeeded", "failed", "cancelled"])

export function isEnded(status: RunStatus): boolean {
  return ENDED_STATUSES.has(status)
}

/** The contract status as the task view's (`TaskRunView.status`). */
export function eventStatusOf(status: RunStatus): EventRunStatus {
  switch (status) {
    case "interrupted":
      return "paused"
    case "succeeded":
      return "done"
    default:
      return status
  }
}

export function taskErrorOf(run: Pick<Run, "error">): TaskError | null {
  const e = run.error as { code?: unknown; message?: unknown } | null
  if (!e) return null
  return {
    code: typeof e.code === "string" ? e.code : "unknown",
    message: typeof e.message === "string" && e.message ? e.message : "The task failed.",
  }
}

/** `RunResult.stoppedAt` (Q81): the task stopped at its step limit. */
export function stoppedAtOf(run: Pick<Run, "result">): "max_steps" | null {
  return (run.result as { stoppedAt?: unknown } | null)?.stoppedAt === "max_steps" ? "max_steps" : null
}

/** The open questions of a run (its `openInterrupts`). */
export function questionsOf(
  run: Run,
  answeredBy: TaskQuestion["answeredBy"],
  extra?: { subagent?: TaskQuestion["subagent"]; answered?: ReadonlySet<string> },
): TaskQuestion[] {
  if (run.status !== "interrupted") return []
  return (run.openInterrupts as Interrupt[]).map((raw) => {
    const interrupt = toPendingInterrupt(raw)
    return {
      runId: run.id,
      rootRunId: run.rootRunId,
      interrupt,
      answeredBy,
      ...(extra?.subagent ? { subagent: extra.subagent } : {}),
      answerPending: run.answerPending || (extra?.answered?.has(answerKey(run.id, interrupt.id)) ?? false),
    }
  })
}

/** The key of one question's answer, for "answer sent" kept locally until
 *  the list shows the run moved on. */
export function answerKey(runId: string, interruptId: string): string {
  return `${runId}:${interruptId}`
}

export function phaseOf(status: RunStatus, questions: readonly TaskQuestion[], childrenAsking: number): TaskPhase {
  switch (status) {
    case "succeeded":
    case "failed":
    case "cancelled":
      return status
    case "interrupted":
      return questions.length > 0 && questions.every((q) => q.answerPending) ? "answer_sent" : "needs_answer"
    default: {
      // A parent waiting on a sub-agent's question.
      const childQuestions = questions.filter((q) => q.answeredBy === "in_place")
      if (childQuestions.length > 0) {
        return childQuestions.every((q) => q.answerPending) ? "answer_sent" : "needs_answer"
      }
      if (childrenAsking > 0) return "needs_answer"
      return status === "queued" ? "queued" : "running"
    }
  }
}

/** A sub-agent run as the task shows it. */
export function childOf(
  run: Run,
  started: { name?: string; subgoal?: string } | undefined,
  answered?: ReadonlySet<string>,
): TaskChild {
  const subagent = started && (started.name || started.subgoal) ? started : undefined
  const questions = questionsOf(run, "in_place", { subagent, answered })
  return {
    runId: run.id,
    ...(started?.name ? { name: started.name } : {}),
    ...(started?.subgoal ? { subgoal: started.subgoal } : {}),
    status: run.status,
    question: questions[0] ?? null,
    error: taskErrorOf(run),
  }
}

export interface SummaryExtras {
  userId: string
  /** The current run's sub-agents, when they have been read. */
  children?: readonly TaskChild[]
  /** Answers this browser sent that the list doesn't show yet. */
  answered?: ReadonlySet<string>
  lastAttemptError?: TaskError | null
  projectTaskId?: string
  /** The root's own `createdAt` (the task's), when known. */
  rootCreatedAt?: string
}

/** The list row of a task, from its current run. */
export function summaryOf(run: Run, extras: SummaryExtras): TaskSummary {
  const own = questionsOf(run, "resume", { answered: extras.answered })
  const childQuestions = (extras.children ?? []).flatMap((c) => (c.question ? [c.question] : []))
  const questions = [...own, ...childQuestions]
  const childrenAsking = Math.max(run.childrenAsking ?? 0, childQuestions.length)
  return {
    rootRunId: run.rootRunId,
    currentRunId: run.id,
    conversationId: run.threadId,
    title: run.goal ?? "",
    research: run.research,
    phase: phaseOf(run.status, questions, childrenAsking),
    status: run.status,
    step: run.step,
    maxSteps: run.maxSteps,
    createdAt: extras.rootCreatedAt ?? run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    questions,
    childrenAsking,
    delivered: run.delivered,
    result: run.status === "succeeded" ? (run.result ?? {}) : null,
    stoppedAt: run.status === "succeeded" ? stoppedAtOf(run) : null,
    error: run.status === "failed" ? taskErrorOf(run) : null,
    lastAttemptError: extras.lastAttemptError ?? null,
    resultIds: resultIdsFor(extras.userId, run.rootRunId),
    ...(extras.projectTaskId ? { projectTaskId: extras.projectTaskId } : {}),
  }
}

/** A start this browser sent that the server hasn't listed yet. */
export function launchingSummary(task: LaunchingTask, userId: string): TaskSummary {
  return {
    rootRunId: task.runId,
    currentRunId: task.runId,
    conversationId: task.threadId,
    title: task.title ?? "",
    research: task.research,
    phase: "launching",
    status: "queued",
    step: null,
    maxSteps: null,
    createdAt: task.startedAt,
    updatedAt: task.startedAt,
    finishedAt: null,
    questions: [],
    childrenAsking: 0,
    delivered: false,
    result: null,
    stoppedAt: null,
    error: null,
    lastAttemptError: null,
    resultIds: resultIdsFor(userId, task.runId),
    ...(task.projectTaskId ? { projectTaskId: task.projectTaskId } : {}),
  }
}

function rank(phase: TaskPhase): number {
  if (phase === "needs_answer") return 0
  return ACTIVE_PHASES.has(phase) ? 1 : 2
}

/** The list's order: needing an answer first, then launching / queued /
 *  running / answer sent, then ended; newest first in each. */
export function orderTasks(tasks: readonly TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => {
    const r = rank(a.phase) - rank(b.phase)
    if (r !== 0) return r
    const t = Date.parse(b.createdAt) - Date.parse(a.createdAt)
    if (t !== 0 && Number.isFinite(t)) return t
    return b.rootRunId < a.rootRunId ? -1 : b.rootRunId > a.rootRunId ? 1 : 0
  })
}
