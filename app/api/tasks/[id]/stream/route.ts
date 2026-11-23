import "server-only"

import type { NextRequest } from "next/server"

import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/server/supabase/server"
import { getRun, listEventsSince, reconcileStaleRuns } from "@/server/agent/store"
import {
  gateLiveTailBatch,
  isTerminalEvent,
  isTerminalStatus,
  type RunStatus,
  type TaskEvent,
  type TaskEventBase,
} from "@/shared/agent/events"
import { toDataPart } from "@/shared/agent/wire"

// How often we re-query the log while tailing an in-flight run, and a
// hard wall-clock backstop so an orphaned run (producer died without
// writing a terminal event) — or a terminal event whose task row never
// turns terminal — can't hold the connection open forever.
const POLL_MS = 1000
const MAX_WALL_MS = 5 * 60_000
// A read this long may have been cut at PostgREST's `max_rows` (1000 by
// default, and dropped rows make a page shorter): read on before judging
// where the log ends.
const READ_ON_FROM = 100

type DB = NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>

/** Everything in the log past `since`. */
async function readEventsSince(
  db: DB,
  id: string,
  userId: string,
  since: number
): Promise<TaskEvent[]> {
  const all: TaskEvent[] = []
  let from = since
  for (;;) {
    const page = await listEventsSince(db, id, userId, from)
    all.push(...page)
    if (page.length < READ_ON_FROM) return all
    from = page[page.length - 1].seq
  }
}

/** The run status an event states, if it states one. */
function statedStatus(event: TaskEvent): RunStatus | undefined {
  return event.kind === "status" || event.kind === "result" ? event.status : undefined
}

/** The terminal event a row that ended without one gets on the wire. It
 *  isn't written to the log. */
function endEvent(base: TaskEventBase, status: RunStatus): TaskEvent {
  if (status === "done") return { ...base, kind: "result", status }
  if (status === "failed") {
    return { ...base, kind: "result", status, error: "The task ended without saying why." }
  }
  return { ...base, kind: "status", status }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Resume / reconnect endpoint. Replays the persisted `task_events` log
 * from `Last-Event-ID` (the native SSE reconnect header, carrying the
 * last `seq` the client folded), then poll-tails new events until the
 * run settles. Emits the same `data-agent-event` parts the live task
 * route does, so the client folds both through the same `reduceRun`.
 *
 * "Settles" means a terminal event (`result`, or `status: cancelled`)
 * is in the log AND the task row's status is terminal; a terminal event
 * the row doesn't confirm yet is held back, not sent (see
 * `gateLiveTailBatch`). The row has the last word the other way round
 * too: one that turned terminal without saying so in the log (cancelled,
 * reconciled), or differently from it (a cancel that beat the result),
 * ends the stream with a terminal event for the row's status. A row
 * deleted meanwhile just ends it: the client's reconnect gets the 404.
 *
 * Live-tailing is poll-based (no pub/sub in v1): the original POST
 * process holds the truly-live stream; this path watches the log the
 * producer writes to. A self-host with realtime can swap the poll loop
 * for a subscription without changing the wire contract.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = await getSupabaseServerClient()
  if (!db) {
    return NextResponse.json(
      { code: "unavailable", message: "Supabase is not configured." },
      { status: 503 }
    )
  }

  const { data: userData, error: authError } = await db.auth.getUser()
  if (authError || !userData.user) {
    return NextResponse.json(
      { code: "auth", message: "Unauthorized." },
      { status: 401 }
    )
  }
  const userId = userData.user.id

  const run = await getRun(db, id, userId)
  if (!run) {
    return NextResponse.json(
      { code: "not_found", message: "Run not found." },
      { status: 404 }
    )
  }

  // Reconnecting is the moment to garbage-collect dead runs: if this (or
  // any of the user's) runs is `running` but the producer died without a
  // terminal event, fail it now so the replay below settles cleanly
  // instead of poll-tailing to the wall-clock cap.
  try {
    await reconcileStaleRuns(db, userId)
  } catch (err) {
    console.error("[tasks] reconcile:", err)
  }

  // `Last-Event-ID` carries the last seq the client already has; replay
  // strictly after it. Absent/garbage → start from the beginning.
  const lastEventId = req.headers.get("last-event-id")
  let cursor = Number.parseInt(lastEventId ?? "", 10)
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const start = Date.now()
      /** What the last status or result event sent says. */
      let said: RunStatus | undefined
      let step = run.step ?? 0
      /** The previous poll saw the row terminal; this one drains and ends. */
      let ended: RunStatus | undefined
      const rowStatus = async () => (await getRun(db, id, userId))?.status as RunStatus | undefined
      while (true) {
        const events = await readEventsSince(db, id, userId, cursor)
        let status = ended
        if (!status && events.some(isTerminalEvent)) {
          status = await rowStatus()
          if (!status) return // deleted
        }
        const rowTerminal = status !== undefined && isTerminalStatus(status)
        // A terminal event only ends the run once the task row is
        // terminal too: a worker can die after writing `result` but
        // before settling, and its reclaimed re-run then supersedes that
        // `result` with a resume marker. Until the row agrees, the
        // terminal event is held back (and re-read next poll); a
        // superseded one is never sent. See `gateLiveTailBatch`.
        const batch = gateLiveTailBatch(events, rowTerminal)
        for (const e of batch.deliver) {
          // The row has the last word on how the run ended.
          if (rowTerminal && isTerminalEvent(e) && statedStatus(e) !== status) continue
          writer.write(toDataPart(e))
          said = statedStatus(e) ?? said
          step = Math.max(step, e.step)
        }
        if (batch.cursor !== null && batch.cursor > cursor) cursor = batch.cursor
        if (status && rowTerminal && (ended || batch.settled)) {
          if (said !== status) {
            const base = { runId: id, seq: cursor + 1, step, createdAt: new Date().toISOString() }
            writer.write(toDataPart(endEvent(base, status)))
          }
          return
        }
        if (req.signal.aborted) return
        if (Date.now() - start > MAX_WALL_MS) return
        // Backstop for a run that ended with no terminal event in the log
        // (producer died mid-flush, cancel, reconcile): drain once more,
        // then end with the row's status.
        const latest = await rowStatus()
        if (!latest) return // deleted
        if (isTerminalStatus(latest)) {
          ended = latest
          // done / failed: the worker may write its event just after the
          // row. A cancel has nothing to wait for.
          if (latest === "cancelled") continue
        }
        await delay(POLL_MS, req.signal)
      }
    },
  })

  return createUIMessageStreamResponse({ stream })
}
