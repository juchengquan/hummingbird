/**
 * Pure codec for the "active task" pointer the client persists so a
 * reload can reconnect to a still-running task (resume-on-reload). The
 * localStorage I/O lives in `lib/client/agent/active-task.ts`; this is
 * just the record shape + a validating parse, mirroring the pure-codec
 * split used by `wire.ts` / `persistence.ts`.
 */

import { z } from "zod"

const runStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "cancelled",
  "done",
  "failed",
])

export const ActiveTaskSchema = z.object({
  runId: z.string().min(1),
  conversationId: z.string().min(1),
  /** Highest `seq` folded — the reconnect cursor. */
  cursor: z.number().int().nonnegative(),
  status: runStatusSchema,
  /** Conversation title, for the finish-while-away notification. */
  title: z.string().optional(),
  /** ISO timestamp of the last update — lets a stale pointer be aged out. */
  updatedAt: z.string().min(1),
})

export type ActiveTaskRecord = z.infer<typeof ActiveTaskSchema>

export function serializeActiveTask(record: ActiveTaskRecord): string {
  return JSON.stringify(record)
}

/** Parse a persisted pointer, returning null for anything malformed
 *  (corrupt JSON, schema skew) so a bad localStorage value is dropped
 *  rather than thrown. */
export function parseActiveTask(raw: string | null | undefined): ActiveTaskRecord | null {
  if (!raw) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = ActiveTaskSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}
