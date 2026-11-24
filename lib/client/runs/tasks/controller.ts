"use client"
import "client-only"

/**
 * The tasks panel on runs (wave 6, Q61, Q69–Q77): the real
 * `TasksContextValue`. `useTasksController()` builds it for the signed-in
 * user; the dashboard hands it to `TasksProvider` (`./context.tsx`).
 *
 * `TasksController` (no React) does the work:
 * - **Only on runs** (Q61): nothing below happens unless "agent-py (runs)"
 *   is selected and the user is signed in — otherwise `availability` is
 *   `not_runs` and the old path lists, delivers and notifies.
 * - **The list** (Q69): `listRuns?mode=background&topLevel=true&current=true`
 *   — one row per task, every task of the user, old-path and scheduled
 *   ones too (Q76) — read every ~5 s while the Tasks panel is open, a
 *   task is active or one is watched, else every minute. Rows needing an
 *   answer come first. A task whose sub-agents ask (`childrenAsking`) has
 *   its children read, so their questions are in the row; an interrupted
 *   task's dead branch (a resume that failed before applying, Q75) is
 *   read once for the note.
 * - **Launching** (Q61, Q71, Q72): the run id is minted and kept in
 *   `humm.tasks.<userId>` before the POST, so a lost response (or a
 *   reload) retries the same request — an idempotent retry, never a
 *   second task. The conversation must have synced (background runs need
 *   it): the launch waits for the sync queue first, and a `404 not_found`
 *   is retried after another drain (survey bug 5).
 * - **Watching** (`./watch.ts`): only tasks someone subscribed to are
 *   streamed, folded across their chain (`./chain.ts`).
 * - **Answers**: the current run's question → a resume (`previousRunId` +
 *   `resume[]`, background); a sub-agent's → `answerRun` in place (Q59).
 *   An accepted answer shows as sent (`answer_sent`) until the list moves
 *   on. `run_already_resumed` / `run_already_answered` mean another tab or
 *   browser answered: the list is read again and the watch follows the
 *   task's current run.
 * - **Delivery** (`./deliver.ts`) and **notifications** (`./notify.ts`),
 *   from the list, once across tabs and browsers.
 *
 * Old-path tasks keep their own watcher (`lib/client/agent/*`, "a task
 * stays on its path", Q61): the list shows them, and delivers them with
 * the same derived ids, so whichever writes first wins and the other is a
 * no-op.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"

import { isAgentPyConfigured } from "@/client/api-client"
import { ensureTaskNotificationPermission } from "@/client/agent/notify"
import { useAuth } from "@/client/hooks/use-auth"
import { modelSwitchNote } from "@/client/hooks/use-model-backend"
import { pullCloudNow } from "@/client/hooks/use-reconcile"
import { useStore } from "@/client/hooks/use-store"
import { whenDrained } from "@/client/sync/sync-queue"
import { EMPTY_RUN_VIEW, type TaskRunView } from "@/shared/agent/project"
import type { TaskRequestInput } from "@/shared/api-schemas"
import { TASK_MODEL_BACKEND, taskModelFor } from "@/shared/backend-models"
import { mintRunId } from "@/shared/runs/ids"

import { answerRun, listRuns, markRunDelivered, resumeBackgroundRun, startBackgroundRun } from "../background"
import { RunsError } from "../errors"
import { buildResume, type InterruptAnswer } from "../interrupts"
import { cancelRun, rejoinRun, type RunStream } from "../transport"
import type { ListRunsQuery, Run, RunCursor, RunList, RunsTarget, ResumeEntry, StartRunRequest } from "../types"
import { ChainFold, generatedImagesOf, pendingInputOf } from "./chain"
import { deliverTask, type DeliveryDeps, type DeliveryStore, type LockLike, type PullResult } from "./deliver"
import { backgroundStartBody } from "./launch-input"
import { browserNotifier, notificationEvents, notifyOnce, type NotifyDeps } from "./notify"
import { LAUNCH_GIVE_UP_MS, TaskPointers, type PointerStorage } from "./pointers"
import {
  ACTIVE_PHASES,
  answerKey,
  childOf,
  eventStatusOf,
  isEnded,
  launchingSummary,
  orderTasks,
  summaryOf,
  taskErrorOf,
} from "./summary"
import type {
  LaunchingTask,
  TaskAnswerResult,
  TaskChild,
  TaskError,
  TaskLaunchOptions,
  TaskLaunchResult,
  TaskQuestion,
  TasksAvailability,
  TasksContextValue,
  TaskSummary,
  TaskView,
} from "./types"
import { TaskWatch, chainLine } from "./watch"

/** At most this many active tasks (Q72). */
export const ACTIVE_TASK_LIMIT = 5
/** The list read while the panel is open, a task is active or watched. */
export const LIST_POLL_MS = 5_000
/** …and otherwise (a scheduled task may finish any time). */
export const LIST_IDLE_POLL_MS = 60_000
/** Undelivered tasks past the list's first page: read every Nth tick. */
const DELIVERY_SCAN_EVERY = 6
const LIST_PAGE_SIZE = 50
/** A conversation missing for a delivery is pulled at most this often. */
const PULL_MIN_INTERVAL_MS = 30_000
/** Launch retries after `404 not_found` (the conversation hasn't synced). */
const NOT_SYNCED_RETRIES = 2

// --- What the controller needs ------------------------------------------------------

export interface TasksApi {
  list(query: ListRunsQuery, signal?: AbortSignal): Promise<RunList>
  start(body: StartRunRequest): Promise<{ runId: string; status: string }>
  resume(request: { runId: string; threadId: string; previousRunId: string; resume: ResumeEntry[] }): Promise<{
    runId: string
    status: string
  }>
  answer(runId: string, resume: ResumeEntry[]): Promise<Run>
  cancel(runId: string): Promise<Run>
  markDelivered(rootRunId: string): Promise<Run>
  stream(runId: string, after: RunCursor, signal: AbortSignal): Promise<RunStream>
}

/** The runs API for a target (`resolveTasksTarget`). */
export function httpTasksApi(target: () => Promise<RunsTarget | null>): TasksApi {
  const t = async () => {
    const resolved = await target()
    if (!resolved) throw new RunsError("http", "auth_required", "Sign in to use tasks.", 401)
    return resolved
  }
  return {
    list: async (query, signal) => listRuns(query, { target: await t(), signal }),
    start: async (body) => startBackgroundRun(body, { target: await t() }),
    resume: async (request) => resumeBackgroundRun(request, { target: await t() }),
    answer: async (runId, resume) => answerRun(runId, resume, { target: await t() }),
    cancel: async (runId) => cancelRun(runId, { target: await t() }),
    markDelivered: async (root) => markRunDelivered(root, { target: await t() }),
    stream: async (runId, after, signal) => rejoinRun(runId, { target: await t(), after, signal }),
  }
}

/** What launching touches outside the runs API. */
export interface LaunchHooks {
  /** Wait for the sync queue (the conversation must be in the cloud). */
  whenDrained(timeoutMs: number): Promise<void>
  openPanel(): void
  /** A note to show (a model switched for the worker, Q55). */
  note(message: string): void
  linkCard(cardId: string, rootRunId: string): void
  revertCard(cardId: string): void
  /** The account's "store files locally" preference. */
  localFilesOnly(): boolean
}

export interface TasksControllerDeps {
  userId: string
  api: TasksApi
  pointers: TaskPointers
  store: DeliveryStore
  launch: LaunchHooks
  availability(): TasksAvailability
  isPanelOpen(): boolean
  locks?: LockLike | null
  pull(): Promise<PullResult>
  whenDrained(): Promise<void>
  notifier: Pick<NotifyDeps, "isHidden" | "show" | "permission">
  now?(): number
  /** Timers (tests). */
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

interface Snapshot {
  tasks: readonly TaskSummary[] | null
  listError: TaskError | null
  activeCount: number
}

function errorOf(err: unknown): TaskError {
  if (err instanceof RunsError) return { code: err.code, message: err.message }
  return { code: "unknown", message: err instanceof Error ? err.message : "Something went wrong." }
}

/** A lost response (or a server hiccup): the request may have been
 *  applied, so it is sent again with the same id. */
function isRetryable(err: unknown): boolean {
  return err instanceof RunsError && (err.kind === "network" || err.status >= 500)
}

const TERMINAL_SUMMARY_KEYS = new Set(["succeeded", "failed", "cancelled"])

export class TasksController {
  private readonly deps: TasksControllerDeps
  private readonly now: () => number

  /** Current runs by root, from the last list read. */
  private rows = new Map<string, Run>()
  /** Sub-agent runs by parent (current) run. */
  private children = new Map<string, Run[]>()
  /** Dead-branch notes by root, with the current-run key they were read for. */
  private lastAttempt = new Map<string, { key: string; error: TaskError | null }>()
  /** Answers accepted from here that the list doesn't show yet. */
  private answered = new Set<string>()
  private launchingInFlight = new Set<string>()
  private deliveringNow = new Set<string>()
  private pulledAt = 0
  private pulling: Promise<PullResult> | null = null

  private watches = new Map<string, { watch: TaskWatch; subscribers: Set<() => void> }>()
  private views = new Map<string, { key: string; view: TaskView }>()
  private listeners = new Set<() => void>()
  private snapshotCache: Snapshot = { tasks: null, listError: null, activeCount: 0 }
  private listError: TaskError | null = null
  private loaded = false
  private version = 0

  private timer: unknown = null
  private ticks = 0
  private disposed = false
  private reading: Promise<void> | null = null
  private readAgain = false

  constructor(deps: TasksControllerDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  // --- Lifecycle ----------------------------------------------------------------------

  start(): void {
    void this.refreshNow()
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    for (const { watch } of this.watches.values()) watch.stop()
    this.watches.clear()
    this.listeners.clear()
  }

  private clearTimer(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>)
    this.timer = null
  }

  private schedule(): void {
    this.clearTimer()
    if (this.disposed) return
    const busy =
      this.deps.isPanelOpen() ||
      this.watches.size > 0 ||
      (this.snapshotCache.tasks ?? []).some((t) => ACTIVE_PHASES.has(t.phase))
    const ms = busy ? LIST_POLL_MS : LIST_IDLE_POLL_MS
    this.timer = (this.deps.setTimer ?? setTimeout)(() => {
      this.timer = null
      void this.refreshNow()
    }, ms)
  }

  /** Read the list now (coalesced with a read in flight). */
  refreshNow(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.reading) {
      this.readAgain = true
      return this.reading
    }
    this.reading = (async () => {
      try {
        do {
          this.readAgain = false
          await this.tick()
        } while (this.readAgain && !this.disposed)
      } finally {
        this.reading = null
        this.schedule()
      }
    })()
    return this.reading
  }

  // --- The external store -------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): Snapshot => this.snapshotCache

  private emit(): void {
    this.version += 1
    const tasks = this.loaded ? this.buildSummaries() : this.launchingOnly()
    this.snapshotCache = {
      tasks,
      listError: this.listError,
      activeCount: (tasks ?? []).filter((t) => ACTIVE_PHASES.has(t.phase)).length,
    }
    for (const l of [...this.listeners]) l()
    for (const { subscribers } of this.watches.values()) for (const s of [...subscribers]) s()
  }

  private launchingOnly(): TaskSummary[] | null {
    const launching = this.deps.pointers.launching()
    return launching.length > 0 ? orderTasks(launching.map((t) => launchingSummary(t, this.deps.userId))) : null
  }

  private summaryFor(run: Run): TaskSummary {
    const kids = this.children.get(run.id)
    const started = this.watches.get(run.rootRunId)?.watch.fold.view.childRuns
    const children = kids?.map((k) => childOf(k, nameOf(started, k.id), this.answered))
    const launching = this.deps.pointers.launching().find((t) => t.runId === run.rootRunId)
    return summaryOf(run, {
      userId: this.deps.userId,
      children,
      answered: this.answered,
      lastAttemptError: this.lastAttempt.get(run.rootRunId)?.error ?? null,
      projectTaskId: launching?.projectTaskId ?? this.deps.store.findCard(run.rootRunId)?.id,
    })
  }

  private buildSummaries(): TaskSummary[] {
    const out: TaskSummary[] = [...this.rows.values()].map((run) => this.summaryFor(run))
    const listed = new Set(out.map((t) => t.rootRunId))
    for (const task of this.deps.pointers.launching()) {
      if (!listed.has(task.runId)) out.push(launchingSummary(task, this.deps.userId))
    }
    return orderTasks(out)
  }

  // --- One read of the list -----------------------------------------------------------

  private async tick(): Promise<void> {
    // Q61: the runs controller lists, delivers and notifies only while
    // "agent-py (runs)" is selected; otherwise the old path does all three.
    if (!this.deps.availability().ok) return
    this.ticks += 1
    let page: RunList
    try {
      page = await this.deps.api.list({
        mode: "background",
        topLevel: true,
        current: true,
        pageSize: LIST_PAGE_SIZE,
      })
    } catch (err) {
      this.listError = errorOf(err)
      this.emit()
      return
    }
    if (this.disposed) return
    this.listError = null
    const previous = this.rows
    this.rows = new Map(page.runs.map((r) => [r.rootRunId, r]))
    this.loaded = true
    // Answers the list has caught up with are no longer "sent from here".
    for (const [root, run] of this.rows) {
      const before = previous.get(root)
      if (before && (before.id !== run.id || before.status !== run.status)) this.forgetAnswers(before.id)
    }

    // Launches the server has listed are no longer "launching".
    const pointers = this.deps.pointers
    for (const task of pointers.launching()) {
      if (this.rows.has(task.runId)) pointers.removeLaunching(task.runId)
    }

    await Promise.all([this.readChildren(), this.readDeadBranches()])
    if (this.disposed) return

    for (const [root, run] of this.rows) {
      this.watches.get(root)?.watch.setCurrent(run.id, run.status)
    }
    this.emit()

    // Side effects of what the list shows.
    const summaries = this.snapshotCache.tasks ?? []
    void this.retryLaunches()
    void this.notifyAll(summaries)
    const undelivered = summaries.filter((t) => !t.delivered && TERMINAL_SUMMARY_KEYS.has(t.status))
    if (this.ticks === 1 || this.ticks % DELIVERY_SCAN_EVERY === 0) {
      undelivered.push(...(await this.scanUndelivered(new Set(undelivered.map((t) => t.rootRunId)))))
    }
    void this.deliverAll(undelivered)
  }

  private forgetAnswers(runId: string): void {
    for (const key of [...this.answered]) if (key.startsWith(`${runId}:`)) this.answered.delete(key)
  }

  /** Sub-agent runs of tasks whose sub-agents ask, and of watched tasks. */
  private async readChildren(): Promise<void> {
    const parents = [...this.rows.values()].filter(
      (r) => !isEnded(r.status) && ((r.childrenAsking ?? 0) > 0 || this.watches.has(r.rootRunId)),
    )
    const next = new Map<string, Run[]>()
    await Promise.all(
      parents.map(async (parent) => {
        try {
          const page = await this.deps.api.list({ parentRunId: parent.id, pageSize: 100 })
          next.set(parent.id, page.runs)
          // A child that took its answer and moved on.
          for (const child of page.runs) if (child.status !== "interrupted") this.forgetAnswers(child.id)
        } catch {
          // Keep the last read (null = the read failed).
          const last = this.children.get(parent.id)
          if (last) next.set(parent.id, last)
        }
      }),
    )
    this.children = next
  }

  /** The note on a reopened question (Q75): the newest resume of the
   *  current run that failed or was cancelled before applying. */
  private async readDeadBranches(): Promise<void> {
    const paused = [...this.rows.values()].filter((r) => r.status === "interrupted")
    await Promise.all(
      paused.map(async (run) => {
        const key = `${run.id}:${run.updatedAt}`
        if (this.lastAttempt.get(run.rootRunId)?.key === key) return
        try {
          const page = await this.deps.api.list({ rootRunId: run.rootRunId, topLevel: true, current: false, pageSize: 100 })
          const dead = page.runs
            .filter((r) => r.previousRunId === run.id && (r.status === "failed" || r.status === "cancelled"))
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
          this.lastAttempt.set(run.rootRunId, {
            key,
            error: dead ? (taskErrorOf(dead) ?? { code: dead.status, message: "The answer couldn't be applied." }) : null,
          })
        } catch {
          // Try again next read.
        }
      }),
    )
  }

  /** Ended tasks not yet delivered, past the list's first page. */
  private async scanUndelivered(skip: ReadonlySet<string>): Promise<TaskSummary[]> {
    try {
      const page = await this.deps.api.list({
        mode: "background",
        topLevel: true,
        current: true,
        delivered: false,
        status: ["succeeded", "failed", "cancelled"],
        pageSize: LIST_PAGE_SIZE,
      })
      return page.runs.filter((r) => !skip.has(r.rootRunId)).map((r) => this.summaryFor(r))
    } catch {
      return []
    }
  }

  // --- Delivery and notifications -----------------------------------------------------

  private deliveryDeps(): DeliveryDeps {
    return {
      userId: this.deps.userId,
      store: this.deps.store,
      pointers: this.deps.pointers,
      locks: this.deps.locks,
      pull: () => this.pullOnce(),
      whenDrained: this.deps.whenDrained,
      markDelivered: async (root) => {
        await this.deps.api.markDelivered(root)
      },
      outputOf: (task) => this.outputOf(task),
      onReportOpened: () => this.deps.launch.note("Report opened in the editor"),
    }
  }

  private pullOnce(): Promise<PullResult> {
    if (this.pulling) return this.pulling
    if (this.now() - this.pulledAt < PULL_MIN_INTERVAL_MS) return Promise.resolve("deferred")
    this.pulledAt = this.now()
    this.pulling = this.deps.pull().finally(() => {
      this.pulling = null
    })
    return this.pulling
  }

  /** A finished task's verification and generated images: the fold of
   *  its chain — the watched one, else its runs read once. */
  private async outputOf(task: TaskSummary) {
    let fold = this.watches.get(task.rootRunId)?.watch.fold
    if (!fold || !fold.isClosed(task.currentRunId)) {
      const runs = (await this.deps.api.list({ rootRunId: task.rootRunId, topLevel: true, pageSize: 100 })).runs
      fold = new ChainFold()
      const line = chainLine(runs, task.currentRunId)
      fold.setLine(line)
      const controller = new AbortController()
      for (const runId of line) {
        const stream = await this.deps.api.stream(runId, "0", controller.signal)
        for await (const item of stream) fold.push(runId, item)
      }
    }
    return { verification: fold.view.verification, images: generatedImagesOf(fold.logs()) }
  }

  private async deliverAll(tasks: readonly TaskSummary[]): Promise<void> {
    const deps = this.deliveryDeps()
    for (const task of tasks) {
      if (this.disposed || this.deliveringNow.has(task.rootRunId)) continue
      this.deliveringNow.add(task.rootRunId)
      try {
        await deliverTask(task, deps)
      } catch {
        // Next read tries again.
      } finally {
        this.deliveringNow.delete(task.rootRunId)
      }
    }
  }

  private async notifyAll(tasks: readonly TaskSummary[]): Promise<void> {
    const deps: NotifyDeps = {
      userId: this.deps.userId,
      pointers: this.deps.pointers,
      locks: this.deps.locks,
      now: this.now,
      ...this.deps.notifier,
    }
    for (const task of tasks) {
      for (const event of notificationEvents(task)) {
        try {
          await notifyOnce(event, deps)
        } catch {
          // best effort
        }
      }
    }
  }

  // --- Launching ----------------------------------------------------------------------

  async launch(input: TaskRequestInput, opts?: TaskLaunchOptions): Promise<TaskLaunchResult> {
    const availability = this.deps.availability()
    if (!availability.ok) {
      return availability.reason !== "not_runs"
        ? { ok: false, code: "auth_required", message: "Sign in to run tasks." }
        : { ok: false, code: "not_runs", message: "Tasks run on the selected backend's own path." }
    }
    const { model, switchedFrom } = taskModelFor(input.model)
    if (!model) return { ok: false, code: "unknown_model", message: "No configured model can run tasks." }
    if (switchedFrom) this.deps.launch.note(modelSwitchNote(TASK_MODEL_BACKEND, switchedFrom, model))
    const runId = mintRunId()
    const body = backgroundStartBody(input, {
      runId,
      model,
      title: opts?.title,
      localFilesOnly: this.deps.launch.localFilesOnly(),
    })
    const record: LaunchingTask = {
      runId,
      threadId: body.threadId,
      ...(opts?.title ? { title: opts.title } : {}),
      research: input.mode === "research",
      ...(opts?.projectTaskId ? { projectTaskId: opts.projectTaskId } : {}),
      body,
      startedAt: new Date(this.now()).toISOString(),
    }
    // Kept before the POST: a lost response retries this very request.
    this.deps.pointers.addLaunching(record)
    this.deps.launch.openPanel()
    this.emit()
    const result = await this.send(record, { first: true })
    this.emit()
    if (result.ok) this.schedule()
    return result
  }

  private async send(record: LaunchingTask, opts: { first: boolean }): Promise<TaskLaunchResult> {
    if (this.launchingInFlight.has(record.runId)) return { ok: true, rootRunId: record.runId }
    this.launchingInFlight.add(record.runId)
    try {
      // The conversation must be in the cloud before the run (bug 5).
      await this.deps.launch.whenDrained(10_000)
      for (let attempt = 0; ; attempt++) {
        try {
          await this.deps.api.start(record.body)
          if (record.projectTaskId) this.deps.launch.linkCard(record.projectTaskId, record.runId)
          return { ok: true, rootRunId: record.runId }
        } catch (err) {
          if (isRetryable(err)) {
            // Maybe created: the record stays, the next read retries it.
            return { ok: true, rootRunId: record.runId }
          }
          const e = errorOf(err)
          if (e.code === "not_found" && attempt < NOT_SYNCED_RETRIES) {
            await this.deps.launch.whenDrained(10_000)
            continue
          }
          this.deps.pointers.removeLaunching(record.runId)
          if (record.projectTaskId) this.deps.launch.revertCard(record.projectTaskId)
          if (!opts.first) this.deps.launch.note(`Couldn't start the task: ${e.message}`)
          return { ok: false, code: e.code, message: e.message }
        }
      }
    } finally {
      this.launchingInFlight.delete(record.runId)
    }
  }

  /** Starts this browser kept and the server hasn't listed: send again. */
  private async retryLaunches(): Promise<void> {
    for (const record of this.deps.pointers.launching()) {
      if (this.rows.has(record.runId) || this.launchingInFlight.has(record.runId)) continue
      if (this.now() - Date.parse(record.startedAt) > LAUNCH_GIVE_UP_MS) {
        this.deps.pointers.removeLaunching(record.runId)
        continue
      }
      await this.send(record, { first: false })
    }
  }

  // --- Answers and cancel -------------------------------------------------------------

  async answer(question: TaskQuestion, answer: InterruptAnswer): Promise<TaskAnswerResult> {
    let resume: ResumeEntry[]
    try {
      resume = buildResume([question.interrupt], { [question.interrupt.id]: answer })
    } catch (err) {
      return { ok: false, code: "invalid_request", message: errorOf(err).message }
    }
    const key = answerKey(question.runId, question.interrupt.id)
    if (question.answeredBy === "in_place") {
      try {
        const run = await this.deps.api.answer(question.runId, resume)
        this.answered.add(key)
        this.replaceChild(run)
        this.emit()
        return { ok: true }
      } catch (err) {
        const e = errorOf(err)
        if (e.code === "run_already_answered") this.answered.add(key)
        void this.refreshNow()
        return { ok: false, code: e.code, message: e.message }
      }
    }
    const run = this.rows.get(question.rootRunId)
    const threadId = run?.threadId
    if (!threadId) return { ok: false, code: "not_found", message: "This task isn't listed any more." }
    const runId = mintRunId()
    for (let attempt = 0; ; attempt++) {
      try {
        await this.deps.api.resume({ runId, threadId, previousRunId: question.runId, resume })
        this.answered.add(key)
        this.emit()
        void this.refreshNow()
        return { ok: true }
      } catch (err) {
        // A lost response: the same id again is an idempotent retry.
        if (isRetryable(err) && attempt < 2) continue
        const e = errorOf(err)
        // Answered elsewhere (another tab or browser), or the question
        // moved on: read the list again — the watch then follows the
        // task's current run.
        void this.refreshNow()
        return { ok: false, code: e.code, message: e.message }
      }
    }
  }

  private replaceChild(child: Run): void {
    if (!child.parentRunId) return
    const kids = this.children.get(child.parentRunId)
    if (!kids) {
      this.children.set(child.parentRunId, [child])
      return
    }
    this.children.set(
      child.parentRunId,
      kids.some((k) => k.id === child.id) ? kids.map((k) => (k.id === child.id ? child : k)) : [...kids, child],
    )
  }

  async cancel(rootRunId: string): Promise<void> {
    const run = this.rows.get(rootRunId)
    const launching = this.deps.pointers.launching().find((t) => t.runId === rootRunId)
    const target = run?.id ?? launching?.runId
    if (!target) return
    try {
      await this.deps.api.cancel(target)
    } catch (err) {
      // A start the server never saw: nothing to cancel there.
      if (launching && errorOf(err).code === "not_found") this.deps.pointers.removeLaunching(rootRunId)
      else throw err
    } finally {
      await this.refreshNow()
    }
  }

  async skipChild(childRunId: string): Promise<void> {
    try {
      const run = await this.deps.api.cancel(childRunId)
      this.replaceChild(run)
      this.emit()
    } finally {
      void this.refreshNow()
    }
  }

  // --- Watching -----------------------------------------------------------------------

  subscribeTask = (rootRunId: string, onChange: () => void): (() => void) => {
    let entry = this.watches.get(rootRunId)
    if (!entry) {
      const current = this.rows.get(rootRunId)?.id ?? rootRunId
      const watch = new TaskWatch(
        rootRunId,
        current,
        {
          chain: async (root, signal) => (await this.deps.api.list({ rootRunId: root, topLevel: true, pageSize: 100 }, signal)).runs,
          stream: (runId, after, signal) => this.deps.api.stream(runId, after, signal),
        },
        () => this.emitTask(rootRunId),
      )
      entry = { watch, subscribers: new Set() }
      this.watches.set(rootRunId, entry)
      const row = this.rows.get(rootRunId)
      if (row) watch.setCurrent(row.id, row.status)
      watch.start()
      // Its sub-agents are read from the next tick on, at the fast pace.
      void this.refreshNow()
    }
    entry.subscribers.add(onChange)
    const subscribers = entry.subscribers
    return () => {
      subscribers.delete(onChange)
      const current = this.watches.get(rootRunId)
      if (current && current.subscribers.size === 0) {
        current.watch.stop()
        this.watches.delete(rootRunId)
        this.views.delete(rootRunId)
      }
    }
  }

  private emitTask(rootRunId: string): void {
    const entry = this.watches.get(rootRunId)
    if (!entry) return
    this.version += 1
    for (const s of [...entry.subscribers]) s()
  }

  getTask = (rootRunId: string): TaskView | null => {
    const summary = (this.snapshotCache.tasks ?? []).find((t) => t.rootRunId === rootRunId)
    if (!summary) return null
    const watch = this.watches.get(rootRunId)?.watch
    const key = `${this.version}`
    const cached = this.views.get(rootRunId)
    if (cached && cached.key === key) return cached.view
    const view = buildTaskView(summary, watch ?? null, this.childrenOf(summary, watch ?? null))
    if (cached && sameView(cached.view, view)) {
      this.views.set(rootRunId, { key, view: cached.view })
      return cached.view
    }
    this.views.set(rootRunId, { key, view })
    return view
  }

  private childrenOf(summary: TaskSummary, watch: TaskWatch | null): TaskChild[] {
    const kids = this.children.get(summary.currentRunId) ?? []
    const started = watch?.fold.view.childRuns
    return kids.map((k) => childOf(k, nameOf(started, k.id), this.answered))
  }
}

function nameOf(
  started: ReadonlyArray<{ childTaskId: string; agent: string; subgoal: string }> | undefined,
  childRunId: string,
): { name?: string; subgoal?: string } | undefined {
  const s = started?.find((c) => c.childTaskId === childRunId)
  return s ? { ...(s.agent ? { name: s.agent } : {}), ...(s.subgoal ? { subgoal: s.subgoal } : {}) } : undefined
}

/** A task's view: its list row plus the fold of its chain. The current
 *  run's status, step, budget and question are the list's, unless the
 *  stream has already closed that run. */
export function buildTaskView(summary: TaskSummary, watch: TaskWatch | null, children: TaskChild[]): TaskView {
  const fold: TaskRunView = watch?.fold.view ?? EMPTY_RUN_VIEW
  const streamedCurrent = watch?.fold.has(summary.currentRunId) ?? false
  const closedHere = watch?.fold.isClosed(summary.currentRunId) ?? false
  const own = summary.questions.find((q) => q.answeredBy === "resume" && !q.answerPending)
  const view: TaskRunView = {
    ...fold,
    status: closedHere ? fold.status : eventStatusOf(summary.status),
    step: streamedCurrent ? Math.max(fold.step, summary.step ?? 0) : (summary.step ?? 0),
    maxSteps: summary.maxSteps,
    pendingInput: own ? pendingInputOf(own.interrupt) : summary.phase === "answer_sent" ? null : fold.pendingInput,
    cursor: 0,
  }
  return {
    ...summary,
    runIds: watch?.runIds.length ? watch.runIds : [summary.rootRunId],
    view,
    children,
    connection: watch ? watch.connection : "closed",
  }
}

function sameView(a: TaskView, b: TaskView): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// --- The app's wiring --------------------------------------------------------------

function storeAdapter(): DeliveryStore {
  const s = () => useStore.getState()
  return {
    getConversation: (id) => {
      const c = s().conversations.find((conv) => conv.id === id)
      return c ? { id: c.id, workspaceId: c.workspaceId, messages: c.messages } : null
    },
    activeWorkspaceId: () => s().activeWorkspaceId || null,
    addMessageWithId: (id, message, conversationId) => s().addMessageWithId(id, message, conversationId) !== null,
    createDocumentWithId: (id, workspaceId, title, content) => {
      s().createDocumentWithId(id, workspaceId, title, content)
    },
    createArtifactWithId: (id, input) => {
      s().createArtifactWithId(id, input)
    },
    setActiveDocument: (id) => s().setActiveDocument(id),
    findCard: (root) => {
      const card = s().projectTasks.find((t) => t.taskId === root)
      return card ? { id: card.id, title: card.title, ...(card.artifactId ? { artifactId: card.artifactId } : {}) } : null
    },
    getCard: (cardId) => {
      const card = s().projectTasks.find((t) => t.id === cardId)
      return card ? { id: card.id, title: card.title, ...(card.artifactId ? { artifactId: card.artifactId } : {}) } : null
    },
    setCardArtifact: (cardId, artifactId) => s().updateProjectTask(cardId, { artifactId }),
    moveCard: (cardId, status) => s().moveProjectTask(cardId, status, 0),
  }
}

function browserLocks(): LockLike | null {
  return typeof navigator !== "undefined" && navigator.locks ? (navigator.locks as unknown as LockLike) : null
}

/** Whether tasks launch on runs here (Q61). */
export function tasksAvailability(
  auth: "loading" | "signed_in" | "signed_out",
  chatBackend: string,
): TasksAvailability {
  if (auth === "loading") return { ok: false, reason: "loading" }
  if (auth === "signed_out") return { ok: false, reason: "signed_out" }
  if (chatBackend !== "python-runs" || !isAgentPyConfigured()) return { ok: false, reason: "not_runs" }
  return { ok: true }
}

/** Build the app's controller for a signed-in user. */
export function createTasksController(
  userId: string,
  availability: () => TasksAvailability,
  storage?: PointerStorage | null,
): TasksController {
  return new TasksController({
    userId,
    api: httpTasksApi(async () => (await import("@/client/api/backend-resolver")).resolveTasksTarget()),
    pointers: new TaskPointers(userId, storage),
    store: storeAdapter(),
    availability,
    isPanelOpen: () => useStore.getState().tasksPanelOpen,
    locks: browserLocks(),
    pull: () => pullCloudNow(userId),
    whenDrained: () => whenDrained(),
    notifier: browserNotifier(),
    launch: {
      whenDrained: (ms) => whenDrained(ms),
      openPanel: () => useStore.getState().setTasksPanelOpen(true),
      note: (message) => toast.info(message),
      linkCard: (cardId, root) => useStore.getState().updateProjectTask(cardId, { taskId: root }),
      revertCard: (cardId) => useStore.getState().moveProjectTask(cardId, "todo", 0),
      localFilesOnly: () => useStore.getState().localFilesOnly,
    },
  })
}

const EMPTY_SNAPSHOT: Snapshot = { tasks: null, listError: null, activeCount: 0 }
const SIGNED_OUT_SNAPSHOT: Snapshot = { tasks: [], listError: null, activeCount: 0 }
const noopSubscribe = () => () => {}

/**
 * The tasks interface for the signed-in user (Q69): hand it to
 * `TasksProvider`. Signed out, or with agent-py unconfigured, it lists
 * nothing and launches nothing (`availability` says why). Another account
 * signing in gets a fresh controller (its own pointers, bug 6).
 */
export function useTasksController(): TasksContextValue {
  const { status, user } = useAuth()
  const chatBackend = useStore((s) => s.chatBackend)
  const panelOpen = useStore((s) => s.tasksPanelOpen)
  const userId = status === "signed-in" ? (user?.id ?? null) : null
  const authState = status === "loading" ? "loading" : userId !== null ? "signed_in" : "signed_out"
  const availability = useMemo(() => tasksAvailability(authState, chatBackend), [authState, chatBackend])
  // Q61: a controller only while tasks run on runs (signed in, "agent-py
  // (runs)" selected, agent-py configured). Otherwise nothing is listed,
  // delivered or notified from here: the old path does it.
  const onRuns = availability.ok
  const availabilityRef = useRef(availability)
  useEffect(() => {
    availabilityRef.current = availability
  }, [availability])

  const [controller, setController] = useState<TasksController | null>(null)
  useEffect(() => {
    if (!userId || !onRuns) {
      setController(null)
      return
    }
    const c = createTasksController(userId, () => availabilityRef.current)
    setController(c)
    c.start()
    return () => c.dispose()
  }, [userId, onRuns])

  // Opening the panel reads the list at once (and at the fast pace).
  useEffect(() => {
    if (panelOpen) void controller?.refreshNow()
  }, [panelOpen, controller])

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.snapshot ?? (() => (onRuns ? EMPTY_SNAPSHOT : SIGNED_OUT_SNAPSHOT)),
    () => EMPTY_SNAPSHOT,
  )

  const [runAsTask, setRunAsTaskState] = useState(false)
  const setRunAsTask = useCallback((value: boolean) => {
    setRunAsTaskState(value)
    // Asked on the user's gesture: tasks notify when they need an answer,
    // fail or finish (Q74).
    if (value) void ensureTaskNotificationPermission()
  }, [])

  return useMemo<TasksContextValue>(
    () => ({
      availability,
      tasks: snapshot.tasks,
      listError: snapshot.listError,
      activeCount: snapshot.activeCount,
      activeLimit: ACTIVE_TASK_LIMIT,
      getTask: controller ? controller.getTask : () => null,
      subscribeTask: controller ? controller.subscribeTask : () => () => {},
      launch: (input, opts) =>
        controller
          ? controller.launch(input, opts)
          : Promise.resolve({
              ok: false as const,
              code: availability.ok || availability.reason === "not_runs" ? "not_runs" : "auth_required",
              message: userId ? "Tasks run on the old path here." : "Sign in to run tasks.",
            }),
      answer: (question, answer) =>
        controller
          ? controller.answer(question, answer)
          : Promise.resolve({ ok: false as const, code: "auth_required", message: "Sign in to answer." }),
      cancel: (root) => (controller ? controller.cancel(root) : Promise.resolve()),
      skipChild: (child) => (controller ? controller.skipChild(child) : Promise.resolve()),
      refresh: () => void controller?.refreshNow(),
      runAsTask,
      setRunAsTask,
    }),
    [availability, snapshot, controller, userId, runAsTask, setRunAsTask],
  )
}
