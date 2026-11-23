import "client-only"

import { useCallback, useEffect, useRef, useState } from "react"

import { apiClient, type TaskEnqueueResult } from "@/client/api-client"
import { subscribeTaskEvents } from "@/client/agent/realtime"
import { isTerminalEvent, isTerminalStatus, type TaskEvent } from "@/shared/agent/events"
import {
  EMPTY_RUN_VIEW,
  isNextEvent,
  reduceRun,
  type TaskRunView,
} from "@/shared/agent/project"
import { decodeTaskEventStream } from "@/shared/agent/stream"
import type { TaskRequestInput } from "@/shared/api-schemas"

/** Pause before re-opening a stream that closed; grows while opens fail. */
const RECONNECT_MS = 1500
const RECONNECT_MAX_MS = 15_000

const TASK_GONE = "This task no longer exists, or belongs to another account."

export interface UseTaskRunOptions {
  /** The run ended: once per watched run, with its final view. A reload
   *  replays the log, so this fires again then — the caller makes what it
   *  does idempotent (`settleTask`). */
  onSettled?: (runId: string, view: TaskRunView) => void
}

export interface UseTaskRunResult {
  /** The folded projection of the event log so far. */
  view: TaskRunView
  /** The run id once the start is accepted, or set (resume). */
  runId: string | null
  /** True from the launch until the task ends — also while it waits on
   *  the user or its sub-agents, and between reconnects. */
  isRunning: boolean
  /** A cancel request is on its way. */
  isCancelling: boolean
  /** A failed start, watch or cancel; distinct from the run's own
   *  `view.fatalError` which comes from a `result: failed` event. */
  error: string | null
  /** Start a new task and watch it. Resolves with the route's answer;
   *  `null` when another start or resume replaced this one first. */
  start: (body: TaskRequestInput) => Promise<TaskEnqueueResult | null>
  /** Watch an existing run from the start of its log. */
  resume: (runId: string) => void
  /** Cancel the run (a child: skip it). */
  cancel: () => Promise<void>
  /** Re-read the run now. */
  refresh: () => void
}

/**
 * Drives one long-running task on the client: folds the `/api/tasks/:id/
 * stream` events through `reduceRun` into a live `TaskRunView`, and keeps
 * watching until the task ends. A paused task is watched too (it may be
 * answered or cancelled elsewhere); a closed or failed stream is re-opened
 * from the cursor. A watch always begins at seq 0, so a reload rebuilds
 * the whole view. One run at a time — `start`/`resume` drop the prior.
 */
export function useTaskRun(options?: UseTaskRunOptions): UseTaskRunResult {
  const [view, setView] = useState<TaskRunView>(EMPTY_RUN_VIEW)
  const [runId, setRunId] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [watchError, setWatchError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const viewRef = useRef<TaskRunView>(EMPTY_RUN_VIEW)
  const runIdRef = useRef<string | null>(null)
  const endedRef = useRef(false)
  /** The cancel was accepted; the stream hasn't confirmed how the run ended yet. */
  const cancelledRef = useRef(false)
  const cancellingRef = useRef(false)
  // Latest options without re-creating the stream callbacks each render.
  const optsRef = useRef(options)
  useEffect(() => {
    optsRef.current = options
  })
  // Stop watching on unmount (e.g. the child-run drill-in Sheet).
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const settle = useCallback((id: string, ended: TaskRunView) => {
    endedRef.current = true
    cancelledRef.current = false
    abortRef.current?.abort()
    viewRef.current = ended
    setView(ended)
    setWatchError(null)
    setActionError(null)
    optsRef.current?.onSettled?.(id, ended)
  }, [])

  /** Fold one event. The stream and Realtime both call this — `reduceRun`
   *  is idempotent by `seq`, so a duplicate delivery is a no-op. */
  const fold = useCallback(
    (id: string, event: TaskEvent) => {
      const next = reduceRun(viewRef.current, event)
      if (next === viewRef.current) return
      if (isTerminalStatus(next.status)) return settle(id, next)
      viewRef.current = next
      setView(cancelledRef.current ? asCancelled(next) : next)
    },
    [settle]
  )

  const follow = useCallback(
    async (id: string, signal: AbortSignal) => {
      // Realtime pushes rows as they're inserted, ahead of the replay and
      // unchecked, so it folds only the event right after the cursor (a
      // later one would make the fold drop what the replay hasn't sent
      // yet) and never a terminal one (a dead worker's `result` can be
      // superseded — the stream sends one only once the task row confirms
      // it, `gateLiveTailBatch`).
      const unsubscribe = subscribeTaskEvents(id, {
        onEvent: (event) => {
          if (signal.aborted || isTerminalEvent(event)) return
          if (isNextEvent(viewRef.current, event)) fold(id, event)
        },
      })
      try {
        let failures = 0
        while (!signal.aborted) {
          const openedAt = Date.now()
          const openedFrom = viewRef.current.cursor
          let problem: string | null = null
          let body: ReadableStream<Uint8Array> | null = null
          try {
            const res = await apiClient.tasks.resume(id, { cursor: openedFrom, signal })
            if (signal.aborted) return
            if (res.ok && res.body) body = res.body
            else if (res.status === 404 && res.error?.code === "not_found") {
              settle(id, { ...asCancelled(viewRef.current), fatalError: TASK_GONE })
              return
            } else {
              problem = res.error?.message ?? `Couldn't read the task (HTTP ${res.status}).`
            }
          } catch {
            problem = "Couldn't reach the server."
          }
          if (body) {
            setWatchError(null)
            try {
              for await (const event of decodeTaskEventStream(body)) {
                if (signal.aborted) break
                fold(id, event)
              }
            } catch {
              // The connection dropped mid-stream: re-open from the cursor.
            }
          }
          if (signal.aborted) return
          if (cancelledRef.current) {
            // The cancel was accepted and the read that followed named no
            // other outcome.
            settle(id, asCancelled(viewRef.current))
            return
          }
          const gotNothing =
            viewRef.current.cursor === openedFrom && Date.now() - openedAt < RECONNECT_MS
          failures = problem || gotNothing ? failures + 1 : 0
          if (problem) setWatchError(`${problem} Retrying…`)
          await wait(Math.min(RECONNECT_MS * 2 ** Math.max(0, failures - 1), RECONNECT_MAX_MS), signal)
        }
      } finally {
        unsubscribe?.()
      }
    },
    [fold, settle]
  )

  /** (Re)open the watch from the current cursor. */
  const watch = useCallback(
    (id: string) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      void follow(id, controller.signal)
    },
    [follow]
  )

  /** Point the hook at another run (or none yet). */
  const switchTo = useCallback(
    (id: string | null) => {
      const previous = runIdRef.current
      if (previous && cancelledRef.current) settle(previous, asCancelled(viewRef.current))
      abortRef.current?.abort()
      viewRef.current = EMPTY_RUN_VIEW
      runIdRef.current = id
      endedRef.current = false
      cancelledRef.current = false
      cancellingRef.current = false
      setView(EMPTY_RUN_VIEW)
      setRunId(id)
      setIsCancelling(false)
      setWatchError(null)
      setActionError(null)
    },
    [settle]
  )

  const start = useCallback(
    async (body: TaskRequestInput) => {
      switchTo(null)
      const controller = new AbortController()
      abortRef.current = controller
      setIsStarting(true)
      let res: TaskEnqueueResult
      try {
        // POST enqueues the start job and returns `{ runId }`; the worker
        // writes the events the stream then serves.
        res = await apiClient.tasks.start(body, { signal: controller.signal })
      } catch {
        res = { ok: false, status: 0, error: { message: "Couldn't reach the server." } }
      }
      if (controller.signal.aborted) return null
      setIsStarting(false)
      if (!res.ok || !res.runId) {
        setActionError(res.error?.message ?? `Task failed (HTTP ${res.status}).`)
        return res
      }
      runIdRef.current = res.runId
      setRunId(res.runId)
      watch(res.runId)
      return res
    },
    [switchTo, watch]
  )

  const resume = useCallback(
    (id: string) => {
      switchTo(id)
      setIsStarting(false)
      watch(id)
    },
    [switchTo, watch]
  )

  const refresh = useCallback(() => {
    if (runIdRef.current && !endedRef.current) watch(runIdRef.current)
  }, [watch])

  const cancel = useCallback(async () => {
    const id = runIdRef.current
    if (!id || endedRef.current || cancellingRef.current) return
    cancellingRef.current = true
    setIsCancelling(true)
    setActionError(null)
    let failure: string | null = null
    try {
      const res = await apiClient.tasks.cancel(id)
      if (!res.ok) failure = res.error?.message ?? `HTTP ${res.status}.`
    } catch {
      failure = "Couldn't reach the server."
    }
    if (runIdRef.current !== id) return // replaced meanwhile
    cancellingRef.current = false
    setIsCancelling(false)
    if (endedRef.current) return
    if (failure) {
      setActionError(`Couldn't cancel: ${failure}`)
      return
    }
    // Cancelled at once. The re-read confirms it, or names the outcome the
    // cancel lost to (it's an idempotent 200 on a finished task too).
    cancelledRef.current = true
    setView(asCancelled(viewRef.current))
    watch(id)
  }, [watch])

  return {
    view,
    runId,
    isRunning: isStarting || (runId !== null && !isTerminalStatus(view.status)),
    isCancelling,
    error: actionError ?? watchError,
    start,
    resume,
    cancel,
    refresh,
  }
}

function asCancelled(view: TaskRunView): TaskRunView {
  return { ...view, status: "cancelled", pendingInput: null }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}
