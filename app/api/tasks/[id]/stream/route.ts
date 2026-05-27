import "server-only"

import type { NextRequest } from "next/server"

import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/server/supabase/server"
import { getRun, listEventsSince } from "@/server/agent/store"
import {
  isTerminalStatus,
  type RunStatus,
  type TaskEvent,
} from "@/shared/agent/events"
import { toDataPart } from "@/shared/agent/wire"

// How often we re-query the log while tailing an in-flight run, and a
// hard wall-clock backstop so an orphaned run (producer died without
// writing a terminal event) can't hold the connection open forever.
const POLL_MS = 1000
const MAX_WALL_MS = 5 * 60_000

/** A terminal event ends the run: a `result` (done/failed) or a
 *  terminal `status` (cancelled). */
function isTerminalEvent(e: TaskEvent): boolean {
  return (
    e.kind === "result" ||
    (e.kind === "status" && isTerminalStatus(e.status))
  )
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

  // `Last-Event-ID` carries the last seq the client already has; replay
  // strictly after it. Absent/garbage → start from the beginning.
  const lastEventId = req.headers.get("last-event-id")
  let cursor = Number.parseInt(lastEventId ?? "", 10)
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const start = Date.now()
      let sawTerminalRow = false
      while (true) {
        const events = await listEventsSince(db, id, userId, cursor)
        for (const e of events) {
          writer.write(toDataPart(e))
          if (e.seq > cursor) cursor = e.seq
        }
        // Terminal event in the log → fully drained, stop.
        if (events.some(isTerminalEvent)) break
        // The previous poll saw the row go terminal; this poll has now
        // drained anything written after it. Stop.
        if (sawTerminalRow) break
        if (req.signal.aborted) break
        if (Date.now() - start > MAX_WALL_MS) break
        // Backstop for an orphaned run: the row is terminal but no
        // terminal event reached the log (producer died mid-flush).
        const latest = await getRun(db, id, userId)
        if (latest && isTerminalStatus(latest.status as RunStatus)) {
          sawTerminalRow = true
        }
        await delay(POLL_MS, req.signal)
      }
    },
  })

  return createUIMessageStreamResponse({ stream })
}
