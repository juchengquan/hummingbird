"use client"
import "client-only"

import { useCallback, useRef, useState } from "react"

import { apiClient } from "@/client/api-client"
import {
  EMPTY_RUN_VIEW,
  reduceRun,
  type TaskRunView,
} from "@/shared/agent/project"
import { decodeTaskEventStream } from "@/shared/agent/stream"
import type { TaskRequestInput } from "@/shared/api-schemas"

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
export function useTaskRun(): UseTaskRunResult {
  const [view, setView] = useState<TaskRunView>(EMPTY_RUN_VIEW)
  const [runId, setRunId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const viewRef = useRef<TaskRunView>(EMPTY_RUN_VIEW)
  const runIdRef = useRef<string | null>(null)

  const consume = useCallback(async (body: ReadableStream<Uint8Array>) => {
    for await (const event of decodeTaskEventStream(body)) {
      if (!runIdRef.current && event.runId) {
        runIdRef.current = event.runId
        setRunId(event.runId)
      }
      const next = reduceRun(viewRef.current, event)
      viewRef.current = next
      setView(next)
    }
  }, [])

  const start = useCallback(
    async (body: TaskRequestInput) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      viewRef.current = EMPTY_RUN_VIEW
      runIdRef.current = null
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

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    viewRef.current = EMPTY_RUN_VIEW
    runIdRef.current = null
    setView(EMPTY_RUN_VIEW)
    setRunId(null)
    setError(null)
    setIsRunning(false)
  }, [])

  return { view, runId, isRunning, error, start, resume, cancel, reset }
}
