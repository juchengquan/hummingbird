"use client"
import "client-only"

/**
 * Live tail for one run's `task_events` via Supabase Realtime
 * (`PLAN-agent-task-queue.md` step 6). The worker writes events from a
 * background invocation; this subscription pushes them to the browser
 * within ~100 ms instead of the resume endpoint's 1 s poll.
 *
 * RLS on `task_events` (own-your-rows) gates the subscription — a
 * subscriber only sees rows their auth.uid() owns, same as the resume
 * endpoint's reads. Returns `null` when Supabase isn't configured (the
 * anonymous mode); the caller's existing poll-tail fallback in
 * `useTaskRun` handles that case.
 *
 * Events delivered here ride alongside the resume endpoint's replay /
 * poll-tail. The fold (`reduceRun`) is idempotent by `seq`, so an event
 * arriving on both paths is a no-op on the second delivery — safe
 * to run both in parallel.
 */

import type { TaskEvent } from "@/shared/agent/events"
import { rowToTaskEvent } from "@/shared/agent/persistence"

import { getSupabaseBrowserClient } from "@/client/supabase/client"

export interface TaskRealtimeOptions {
  onEvent: (event: TaskEvent) => void
  /** Fires on a subscription error so the caller can fall back to the
   *  poll-tail. Soft — not every Realtime status update is an error. */
  onError?: (err: unknown) => void
}

/**
 * Subscribe to live `task_events` INSERTs for `taskId`. Returns an
 * `unsubscribe` function (always safe to call multiple times) or
 * `null` when Realtime isn't available (anonymous mode / Supabase
 * env missing).
 */
export function subscribeTaskEvents(
  taskId: string,
  opts: TaskRealtimeOptions
): (() => void) | null {
  const supabase = getSupabaseBrowserClient()
  if (!supabase) return null

  const channel = supabase
    .channel(`task_events:${taskId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "task_events",
        filter: `task_id=eq.${taskId}`,
      },
      (payload) => {
        const event = rowToTaskEvent(
          payload.new as Parameters<typeof rowToTaskEvent>[0]
        )
        if (event) opts.onEvent(event)
      }
    )
    .subscribe((status, err) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        opts.onError?.(err ?? new Error(`Realtime subscription ${status}`))
      }
    })

  let unsubbed = false
  return () => {
    if (unsubbed) return
    unsubbed = true
    void supabase.removeChannel(channel)
  }
}
