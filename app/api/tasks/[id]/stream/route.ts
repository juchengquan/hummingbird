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
} from "@/shared/agent/events"
import { toDataPart } from "@/shared/agent/wire"

// How often we re-query the log while tailing an in-flight run, and a
// hard wall-clock backstop so an orphaned run (producer died without
// writing a terminal event) — or a terminal event whose task row never
// turns terminal — can't hold the connection open forever.
const POLL_MS = 1000
const MAX_WALL_MS = 5 * 60_000

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
 * `gateLiveTailBatch`).
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
      let sawTerminalRow = false
      const rowIsTerminal = async () => {
        const latest = await getRun(db, id, userId)
        return !!latest && isTerminalStatus(latest.status as RunStatus)
      }
      while (true) {
        const events = await listEventsSince(db, id, userId, cursor)
        // A terminal event only ends the run once the task row is
        // terminal too: a worker can die after writing `result` but
        // before settling, and its reclaimed re-run then supersedes that
        // `result` with a resume marker. Until the row agrees, the
        // terminal event is held back (and re-read next poll); a
        // superseded one is never sent. See `gateLiveTailBatch`.
        const batch = gateLiveTailBatch(
          events,
          events.some(isTerminalEvent) ? await rowIsTerminal() : false
        )
        for (const e of batch.deliver) writer.write(toDataPart(e))
        if (batch.cursor !== null && batch.cursor > cursor) cursor = batch.cursor
        if (batch.settled) break
        // The previous poll saw the row go terminal; this poll has now
        // drained anything written after it. Stop.
        if (sawTerminalRow) break
        if (req.signal.aborted) break
        if (Date.now() - start > MAX_WALL_MS) break
        // Backstop for an orphaned run: the row is terminal but no
        // terminal event reached the log (producer died mid-flush).
        if (await rowIsTerminal()) sawTerminalRow = true
        await delay(POLL_MS, req.signal)
      }
    },
  })

  return createUIMessageStreamResponse({ stream })
}
