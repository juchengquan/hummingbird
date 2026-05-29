/**
 * Persistence row codec for the agent event log — `TaskEvent` ↔ a
 * `task_events` row (migration `0012_tasks.sql`). The DB row shape is
 * not the IR shape: the row hoists `seq` / `step` / `kind` /
 * `created_at` into columns (so the resume query can order + filter
 * by `seq` and the index works) and stashes the kind-specific fields
 * in a `payload` JSONB blob. This module is the pure mapping between
 * the two — analogous to the wire codec (`lib/shared/agent/wire.ts`)
 * but for the database boundary. Lives in `shared/` because the client
 * also decodes rows now: Supabase Realtime push delivers them direct
 * to the browser (`lib/client/agent/realtime.ts`).
 *
 * `rowToEvent` re-validates through the same `TaskEventSchema` the
 * wire codec uses, so a row written by a newer producer (a future
 * `kind` this reader predates, a malformed payload) is dropped rather
 * than fed downstream — the resume path stays robust. Pure, no I/O;
 * the actual queries live in the RunStore (runner slice).
 */

import type { TaskEvent } from "@/shared/agent/events"
import { TaskEventSchema } from "@/shared/agent/wire"
import type { Database, Json } from "@/shared/supabase/types"

export type TaskEventInsert = Database["public"]["Tables"]["task_events"]["Insert"]
export type TaskEventRow = Database["public"]["Tables"]["task_events"]["Row"]

/** The base fields hoisted into columns; everything else on the event
 *  is the kind-specific payload. */
export function taskEventToRow(event: TaskEvent, userId: string): TaskEventInsert {
  const { runId, seq, step, createdAt, kind, ...payload } = event
  return {
    task_id: runId,
    user_id: userId,
    seq,
    step,
    kind,
    payload: payload as Json,
    created_at: createdAt,
  }
}

/** Reassemble a row into a `TaskEvent`, validating through the IR
 *  schema. Returns `null` for anything that doesn't validate (future
 *  kind, malformed payload, corrupt row) so resume replay can skip it
 *  without throwing. Accepts the minimal row subset the resume query
 *  selects. */
export function rowToTaskEvent(
  row: Pick<TaskEventRow, "task_id" | "seq" | "step" | "kind" | "payload" | "created_at">
): TaskEvent | null {
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {}
  const candidate = {
    runId: row.task_id,
    seq: row.seq,
    step: row.step,
    createdAt: row.created_at,
    kind: row.kind,
    ...payload,
  }
  const parsed = TaskEventSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/** Map a batch of rows to events, dropping any that don't validate and
 *  returning them in ascending `seq` order — the shape the resume
 *  endpoint hands to the client / `projectRun`. */
export function rowsToTaskEvents(
  rows: Pick<TaskEventRow, "task_id" | "seq" | "step" | "kind" | "payload" | "created_at">[]
): TaskEvent[] {
  const out: TaskEvent[] = []
  for (const row of rows) {
    const e = rowToTaskEvent(row)
    if (e) out.push(e)
  }
  out.sort((a, b) => a.seq - b.seq)
  return out
}
