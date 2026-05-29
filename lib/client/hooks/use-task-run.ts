"use client"
import "client-only"

import { useCallback, useEffect, useRef, useState } from "react"

import { apiClient } from "@/client/api-client"
import {
  clearActiveTask,
  saveActiveTask,
} from "@/client/agent/active-task"
import { notifyTaskFinished } from "@/client/agent/notify"
import { isTerminalStatus } from "@/shared/agent/events"
import {
  EMPTY_RUN_VIEW,
  reduceRun,
  type TaskRunView,
} from "@/shared/agent/project"
import { decodeTaskEventStream } from "@/shared/agent/stream"
import type {
  RespondRequestInput,
  TaskRequestInput,
} from "@/shared/api-schemas"

export interface UseTaskRunOptions {
  /** When set, persist a resume pointer for this conversation as the run
   *  streams and clear it on settle — enables resume-on-reload. */
  conversationId?: string
  /** Conversation title carried into the resume pointer + notification. */
  title?: string
  /** Fire a browser notification when the run settles while the tab is
   *  hidden. Permission must be requested separately. */
  notifyOnFinish?: boolean
}

export interface UseTaskRunResult {
  /** The folded projection of the event log so far. */
  view: TaskRunView
  /** The run id once the first event arrives (start) or set (resume). */
  runId: string | null
  /** True while a stream is open. */
  isRunning: boolean
  /** Transport-level error (network / HTTP), distinct from the run's own
   *  `view.fatalError` which comes from a `result: failed` event. */
  error: string | null
  /** Start a new task and stream it. */
  start: (body: TaskRequestInput) => Promise<void>
  /** Reconnect to an existing run, replaying from `cursor` then tailing. */
  resume: (runId: string, cursor?: number) => Promise<void>
  /** Request cancellation and close the local stream. */
  cancel: () => Promise<void>
  /** Resolve a HITL pending input and consume the continuation stream. */
  respond: (runId: string, body: RespondRequestInput) => Promise<void>
  /** Drop all state and abort any open stream. */
  reset: () => void
}

/**
 * Drives one long-running task on the client: opens the `/api/tasks`
 * (or resume) stream, decodes `data-agent-event` parts, and folds them
 * through `reduceRun` into a live `TaskRunView`. The fold runs against
 * a ref so a reconnect can continue from the current cursor without a
 * stale closure. One run at a time — `start`/`resume` abort the prior.
 */
export function useTaskRun(options?: UseTaskRunOptions): UseTaskRunResult {
  const [view, setView] = useState<TaskRunView>(EMPTY_RUN_VIEW)
  const [runId, setRunId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const viewRef = useRef<TaskRunView>(EMPTY_RUN_VIEW)
  const runIdRef = useRef<string | null>(null)
  // Latest options without re-creating the stream callbacks each render.
  const optsRef = useRef(options)
  useEffect(() => {
    optsRef.current = options
  })
  // Last (status, step) we wrote to the resume pointer, so token-only
  // updates don't hammer localStorage.
  const persistedRef = useRef<{ status: string; step: number } | null>(null)

  /** One stream worth of events — used directly by the outer `consume`
   *  and by the auto-reconnect loop. Kept above its caller so the
   *  useCallback exhaustive-deps check stays clean. */
  const consumeOnce = useCallback(async (body: ReadableStream<Uint8Array>) => {
    for await (const event of decodeTaskEventStream(body)) {
      if (!runIdRef.current && event.runId) {
        runIdRef.current = event.runId
        setRunId(event.runId)
      }
      const next = reduceRun(viewRef.current, event)
      viewRef.current = next
      setView(next)

      const opts = optsRef.current
      const id = runIdRef.current
      if (opts?.conversationId && id) {
        if (isTerminalStatus(next.status)) {
          clearActiveTask()
          persistedRef.current = null
          if (opts.notifyOnFinish && next.status === "done") {
            notifyTaskFinished(next, { title: opts.title })
          }
        } else if (
          persistedRef.current?.status !== next.status ||
          persistedRef.current?.step !== next.step
        ) {
          persistedRef.current = { status: next.status, step: next.step }
          saveActiveTask({
            runId: id,
            conversationId: opts.conversationId,
            cursor: next.cursor,
            status: next.status,
            title: opts.title,
            updatedAt: new Date().toISOString(),
          })
        }
      }
    }
  }, [])

  const consume = useCallback(
    async (body: ReadableStream<Uint8Array>) => {
      await consumeOnce(body)
      // Auto-reconnect on a non-terminal close. This is how chunking
      // (the task-queue plan) ends up transparent: the inline POST
      // stream closes when the route yields to a worker (status stays
      // `running`, no terminal event); the client opens a fresh resume
      // stream a beat later and folds the worker's events as they
      // arrive. We bail out as soon as the run settles, the user
      // pauses for HITL, the user cancels, or nothing was streamed at
      // all (treated as the server having nothing to say — preventing
      // a tight reconnect loop on a genuinely broken endpoint).
      while (
        !abortRef.current?.signal.aborted &&
        viewRef.current.cursor > 0 &&
        !isStableStatus(viewRef.current.status) &&
        runIdRef.current
      ) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1500)
          abortRef.current?.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t)
              resolve()
            },
            { once: true }
          )
        })
        if (abortRef.current?.signal.aborted) break
        const id = runIdRef.current
        if (!id) break
        const next = await apiClient.tasks.resume(id, {
          cursor: viewRef.current.cursor,
          signal: abortRef.current?.signal,
        })
        if (!next.ok || !next.body) break
        await consumeOnce(next.body)
      }
    },
    [consumeOnce]
  )

  const start = useCallback(
    async (body: TaskRequestInput) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      viewRef.current = EMPTY_RUN_VIEW
      runIdRef.current = null
      persistedRef.current = null
      setView(EMPTY_RUN_VIEW)
      setRunId(null)
      setError(null)
      setIsRunning(true)
      try {
        const result = await apiClient.tasks.start(body, {
          signal: controller.signal,
        })
        if (!result.ok || !result.body) {
          setError(
            result.error?.message ?? `Task failed (HTTP ${result.status}).`
          )
          return
        }
        await consume(result.body)
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Task stream failed.")
        }
      } finally {
        if (abortRef.current === controller) setIsRunning(false)
      }
    },
    [consume]
  )

  const resume = useCallback(
    async (id: string, cursor = 0) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      runIdRef.current = id
      persistedRef.current = null
      setRunId(id)
      setError(null)
      setIsRunning(true)
      try {
        const result = await apiClient.tasks.resume(id, {
          cursor,
          signal: controller.signal,
        })
        if (!result.ok || !result.body) {
          setError(
            result.error?.message ?? `Resume failed (HTTP ${result.status}).`
          )
          return
        }
        await consume(result.body)
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Resume stream failed.")
        }
      } finally {
        if (abortRef.current === controller) setIsRunning(false)
      }
    },
    [consume]
  )

  const cancel = useCallback(async () => {
    const id = runIdRef.current
    abortRef.current?.abort()
    setIsRunning(false)
    if (id) await apiClient.tasks.cancel(id)
  }, [])

  const respond = useCallback(
    async (id: string, body: RespondRequestInput) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      runIdRef.current = id
      setRunId(id)
      setError(null)
      setIsRunning(true)
      try {
        const result = await apiClient.tasks.respond(id, body, {
          signal: controller.signal,
        })
        if (!result.ok || !result.body) {
          setError(
            result.error?.message ?? `Respond failed (HTTP ${result.status}).`
          )
          return
        }
        await consume(result.body)
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error ? err.message : "Respond stream failed."
          )
        }
      } finally {
        if (abortRef.current === controller) setIsRunning(false)
      }
    },
    [consume]
  )

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    viewRef.current = EMPTY_RUN_VIEW
    runIdRef.current = null
    persistedRef.current = null
    setView(EMPTY_RUN_VIEW)
    setRunId(null)
    setError(null)
    setIsRunning(false)
  }, [])

  return { view, runId, isRunning, error, start, resume, cancel, respond, reset }
}

/** Statuses where the auto-reconnect loop should stop — terminal
 *  outcomes plus `paused` (HITL takes over via `respond`). Anything
 *  else (`queued` / `running`) signals the worker is still cooking,
 *  so we open a fresh stream and keep watching. */
function isStableStatus(status: TaskRunView["status"]): boolean {
  return status === "paused" || isTerminalStatus(status)
}
