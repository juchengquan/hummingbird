import "client-only"

/**
 * The tasks panel on runs (wave 6: Q69–Q77): one task folded across its
 * runs, and the interface every surface that shows or launches tasks
 * codes against — the Tasks panel, the chat's launch points and inline
 * pointer, the project board, the dashboard (wave 6-D). Wave 6-C
 * implements it (a `TasksContextValue` handed to `TasksProvider` in
 * `./context.tsx`); until then a surface can be built and tested against
 * a fake value.
 *
 * A **task** is a top-level background run (its root), the runs that
 * answered it and their sub-agent runs; it is identified by its root's
 * id (`Run.rootRunId`) for life. Its state is its **current run**'s
 * (`Run.currentRunId`, RUN_EVENTS.md § 4.5). Every task of the user is
 * listed — old-path and scheduled ones included (Q76).
 *
 * Types only, plus the pointer key.
 */

import type { TaskRunView } from "@/shared/agent/project"
import type { TaskRequestInput } from "@/shared/api-schemas"
import type { TaskResultIds } from "@/shared/runs/ids"

import type { InterruptAnswer, PendingInterrupt } from "../interrupts"
import type { RunResult, RunStatus, StartRunRequest } from "../types"

// --- One task ---------------------------------------------------------------------

/**
 * Where a task stands: one value for its badge and its place in the list.
 *
 * - `launching` — this browser sent (or will retry) the start; the server
 *   hasn't listed it yet.
 * - `queued` / `running` — the current run's status; `running` includes a
 *   parent waiting on its sub-agent runs.
 * - `needs_answer` — a question is open on the current run or one of its
 *   sub-agent runs (`questions`), and not every one has an answer sent.
 * - `answer_sent` — every open question has an accepted answer the worker
 *   hasn't picked up yet (`Run.answerPending`).
 * - `succeeded` / `failed` / `cancelled` — the task ended.
 */
export type TaskPhase =
  | "launching"
  | "queued"
  | "running"
  | "needs_answer"
  | "answer_sent"
  | "succeeded"
  | "failed"
  | "cancelled"

/** A failure as the backend reported it (`RunError`, an `ApiError`). */
export interface TaskError {
  code: string
  message: string
}

/**
 * One open question of a task.
 *
 * - `answeredBy: "resume"` — the task's current run asks; answering starts
 *   a new run with `previousRunId` (Q24).
 * - `answeredBy: "in_place"` — a sub-agent run asks; it is answered with
 *   `answerRun` and continues itself (Q59, RUN_EVENTS.md § 4.4).
 */
export interface TaskQuestion {
  /** The run that waits on it. */
  runId: string
  /** The task it belongs to. */
  rootRunId: string
  interrupt: PendingInterrupt
  answeredBy: "resume" | "in_place"
  /** A sub-agent's question: which sub-agent (`SUBAGENT_STARTED`'s name and
   *  subgoal, when the parent's stream has been read). */
  subagent?: { name?: string; subgoal?: string }
  /** An answer was accepted and no worker has picked it up yet: show it
   *  as answered (`Run.answerPending`). */
  answerPending: boolean
}

/** One sub-agent run of the task's current run. */
export interface TaskChild {
  runId: string
  name?: string
  subgoal?: string
  status: RunStatus
  /** Its open question, when it waits on one. */
  question: TaskQuestion | null
  error: TaskError | null
}

/**
 * A task as the list shows it — built from its current run's `Run` (the
 * list reads `listRuns?mode=background&topLevel=true&current=true`), so
 * no stream is needed.
 */
export interface TaskSummary {
  /** The task's id: its root run. */
  rootRunId: string
  /** The run carrying the task's state (the list row's `id`). */
  currentRunId: string
  /** The conversation (`Run.threadId`). A scheduled task's is created on
   *  the server and may not be in this browser until the next pull. */
  conversationId: string
  /** `Run.goal`. */
  title: string
  research: boolean
  phase: TaskPhase
  /** The current run's status. */
  status: RunStatus
  /** The current run's progress: `step` and `maxSteps` restart in every
   *  run of a chain (a resume starts at 0). */
  step: number | null
  maxSteps: number | null
  /** The current run's times (the task's own, until it is answered). */
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  /** The open questions known from the list: the current run's
   *  (`openInterrupts`). A sub-agent's arrive with the task's view, or
   *  once its children are read; `childrenAsking` counts them meanwhile. */
  questions: TaskQuestion[]
  /** Sub-agent runs of the current run waiting on an answer. */
  childrenAsking: number
  /** The result was written into the conversation and marked (Q77). */
  delivered: boolean
  /** A succeeded task's result (the whole answer across its runs, Q78). */
  result: RunResult | null
  /** A succeeded task that stopped at its step limit and delivered what it
   *  had (Q81, `RunResult.stoppedAt`): show the "stopped at the step
   *  limit" note. Null otherwise. */
  stoppedAt: "max_steps" | null
  /** A failed task's error. */
  error: TaskError | null
  /** A resume that failed or was cancelled before applying its answer
   *  (Q75: a dead branch): the question is open again, and this is the
   *  note shown on it. Null otherwise. */
  lastAttemptError: TaskError | null
  /** The ids its result is written under (`resultIdsFor`). */
  resultIds: TaskResultIds
  /** The board card it was launched from, when this browser knows it. */
  projectTaskId?: string
}

/** A task being watched: the list row plus the fold of its runs' streams. */
export interface TaskView extends TaskSummary {
  /** The task's top-level runs, oldest first: the root, its answers and
   *  any dead branches. */
  runIds: string[]
  /** The fold of the chain's streams, in order — text, reasoning, plan,
   *  tool calls, step errors, the verification. `status`, `step`,
   *  `maxSteps` and `pendingInput` are the current run's; `cursor` is
   *  unused (runs cursors are per run, and strings). */
  view: TaskRunView
  /** The current run's sub-agent runs. */
  children: TaskChild[]
  /** The stream of the current run: following it, reconnecting (a
   *  dropped connection or a refreshed sign-in), or closed (it ended or
   *  paused on a question). */
  connection: "live" | "reconnecting" | "closed"
}

// --- What a surface can do ----------------------------------------------------------

/** Whether this browser can launch tasks, and why not. */
export type TasksAvailability =
  | { ok: true }
  /** The sign-in session is still being read: show nothing yet (don't
   *  flash the signed-out state). */
  | { ok: false; reason: "loading" }
  /** Background runs need sign-in (`401 auth_required`): hide the Task
   *  toggle and the board's start. */
  | { ok: false; reason: "signed_out" }
  /** The selected backend isn't "agent-py (runs)" (Q61): tasks launch,
   *  are listed, delivered and notified on the old path; the runs
   *  controller does nothing (on runs, the list shows every task — Q76). */
  | { ok: false; reason: "not_runs" }

export interface TaskLaunchOptions {
  /** The task's title in the list (default: the goal). */
  title?: string
  /** The board card this launches; it is linked to the task's root. */
  projectTaskId?: string
}

/**
 * A launch's outcome. Refusals come before anything is created:
 * `limit_reached` (5 active tasks, Q72), `auth_required`, `unknown_model`,
 * `not_found` (the conversation hasn't synced yet), `invalid_request`.
 */
export type TaskLaunchResult =
  | { ok: true; rootRunId: string }
  | { ok: false; code: string; message: string }

/**
 * An answer's outcome. A refusal means the question has moved on —
 * `run_already_resumed` / `run_already_answered` (answered elsewhere:
 * follow the task's current run), `run_answer_applied` (an earlier answer
 * was acted on and the task failed), `invalid_state` (cancelled or
 * ended) — or, `limit_reached`, that it can be sent again shortly.
 */
export type TaskAnswerResult =
  | { ok: true }
  | { ok: false; code: string; message: string }

export interface TasksContextValue {
  availability: TasksAvailability
  /** Every task of the signed-in user (null until the first list read,
   *  `[]` signed out), ordered: needing an answer first, then
   *  launching / queued / running, then ended, newest first in each. */
  tasks: readonly TaskSummary[] | null
  /** The last list read failed; `tasks` is the one before it. */
  listError: TaskError | null
  /** Tasks counting against the cap: launching, queued, running,
   *  needs_answer, answer_sent. */
  activeCount: number
  /** The cap (5, Q72). */
  activeLimit: number
  /** The view of a task, or null when it isn't listed. Returns the same
   *  object until the task changes (a `useSyncExternalStore` snapshot). */
  getTask(rootRunId: string): TaskView | null
  /** Follow a task while subscribed: its current run's stream (only
   *  watched tasks are streamed) and its sub-agent runs. Returns the
   *  unsubscribe. */
  subscribeTask(rootRunId: string, onChange: () => void): () => void
  /** Start a task. Every launch point passes here: it switches a model
   *  the worker can't run (Q55), sends images in the message and no
   *  attachments (Q71), keeps the run id before the POST (a reload
   *  retries the same id), opens the Tasks panel. */
  launch(input: TaskRequestInput, opts?: TaskLaunchOptions): Promise<TaskLaunchResult>
  /** Answer one question: a resume for the current run's, `answerRun`
   *  for a sub-agent's. */
  answer(question: TaskQuestion, answer: InterruptAnswer): Promise<TaskAnswerResult>
  /** Cancel the whole task: its chain and sub-agent runs (Q60). */
  cancel(rootRunId: string): Promise<void>
  /** Cancel one sub-agent run; its parent continues without it (Q60). */
  skipChild(childRunId: string): Promise<void>
  /** Read the list again now. */
  refresh(): void
  /** The chat input's "Run as task" toggle. */
  runAsTask: boolean
  setRunAsTask(value: boolean): void
}

// --- What this browser keeps, per user (Q68) ------------------------------------------

/** localStorage key prefix: one record per signed-in user. */
export const TASKS_POINTER_KEY_PREFIX = "humm.tasks."

/** The localStorage key of `userId`'s task pointers. */
export function tasksPointerKey(userId: string): string {
  return `${TASKS_POINTER_KEY_PREFIX}${userId}`
}

/** A start this browser sent and hasn't seen accepted: the run id was kept
 *  before the POST, so a reload retries the same request (an idempotent
 *  retry, never a second task). */
export interface LaunchingTask {
  runId: string
  threadId: string
  title?: string
  research: boolean
  projectTaskId?: string
  /** The request as sent. */
  body: StartRunRequest
  /** ISO time of the first attempt. */
  startedAt: string
}

/** A notification this browser showed (Q74: once each, across tabs). */
export type TaskNotificationKind = "done" | "failed" | "needs_answer"

/** `humm.tasks.<userId>` — what one browser keeps about the user's tasks.
 *  The server is the authority on everything else. */
export interface TasksPointers {
  v: 1
  launching: LaunchingTask[]
  /** rootRunId → ISO time this browser wrote the result, kept until the
   *  server's `delivered` mark is seen (another tab skips it meanwhile). */
  delivered: Record<string, string>
  /** `taskNotificationKey(...)` → ISO time it was shown. */
  notified: Record<string, string>
}

/** The `notified` key of one notification: per task and event, and for a
 *  question per question (`needs_answer` of a run's interrupt). */
export function taskNotificationKey(
  rootRunId: string,
  kind: TaskNotificationKind,
  question?: { runId: string; interruptId: string },
): string {
  return question
    ? `${rootRunId}:${kind}:${question.runId}:${question.interruptId}`
    : `${rootRunId}:${kind}`
}
