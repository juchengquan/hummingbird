/**
 * Pure codec for the per-conversation "active run" pointers chat on runs
 * persists, so a reload can rejoin an in-progress answer (Q36) or show the
 * answer cards of an interrupted one (Q35). The localStorage I/O lives in
 * `lib/client/runs/active-run.ts`; this is the record shape + a validating
 * parse, mirroring `lib/shared/agent/active-task.ts` (one slot per
 * conversation here, where tasks keep a single slot).
 */

import { z } from "zod"

import { isRunCursor } from "./cursor"
import { isUuid } from "./ids"

export const ActiveRunSchema = z.object({
  /** The run (a UUID the client minted). */
  runId: z.string().refine(isUuid),
  /** Its thread (`threadIdFor(conversationId)`). */
  threadId: z.string().refine(isUuid),
  /** The store conversation the run's output goes to. */
  conversationId: z.string().min(1),
  /** The assistant message the run's output is written into. */
  messageId: z.string().min(1),
  /** `running` — rejoin on reload; `interrupted` — waiting for answers. */
  status: z.enum(["running", "interrupted"]),
  /** Last SSE id received (`"0"` before any). */
  cursor: z.string().refine(isRunCursor),
  /** No session when it started — addressed by its `X-Run-Token`. */
  anonymous: z.boolean(),
  /** The model it ran with, so a resume uses the same one. */
  model: z.string().optional(),
  /** The MCP allow-list it ran with (ids only), so a resume from another
   *  page keeps it (Q51): `[]` is no MCP, absent is no restriction. */
  allowedMcpServerIds: z.array(z.string()).optional(),
  /** ISO timestamp of the last update — lets a stale pointer be aged out. */
  updatedAt: z.string().min(1),
})

export type ActiveRunRecord = z.infer<typeof ActiveRunSchema>

/** Every pointer, keyed by conversation id. */
export type ActiveRunMap = Record<string, ActiveRunRecord>

export function serializeActiveRuns(map: ActiveRunMap): string {
  return JSON.stringify(map)
}

/** Parse the persisted map; malformed entries (corrupt JSON, schema skew,
 *  a key that isn't the record's conversation) are dropped, never thrown. */
export function parseActiveRuns(raw: string | null | undefined): ActiveRunMap {
  if (!raw) return {}
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return {}
  const out: ActiveRunMap = {}
  for (const [conversationId, value] of Object.entries(json)) {
    const parsed = ActiveRunSchema.safeParse(value)
    if (parsed.success && parsed.data.conversationId === conversationId) {
      out[conversationId] = parsed.data
    }
  }
  return out
}
