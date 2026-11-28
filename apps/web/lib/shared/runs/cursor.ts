/**
 * Replay cursors (`RunCursor` in `packages/contract/openapi.yaml`): the
 * SSE `id` of a run stream's event, `<seq>` or `<seq>.<k>` — `k` orders
 * the AG-UI events one log entry produced, and an entry's last event
 * carries the plain `<seq>` (RUN_EVENTS.md § 6.2). `"0"` is before the
 * first entry.
 *
 * Pure and isomorphic.
 */

export const START_CURSOR = "0"

const CURSOR_RE = /^(0|[1-9][0-9]{0,9})(\.(0|[1-9][0-9]{0,3}))?$/

export function isRunCursor(value: unknown): value is string {
  return typeof value === "string" && CURSOR_RE.test(value)
}

/** `[seq, k]`, with a plain `<seq>` after every `<seq>.<k>`. */
function key(cursor: string): [number, number] {
  const [seq, k] = cursor.split(".")
  return [Number(seq), k === undefined ? Number.POSITIVE_INFINITY : Number(k)]
}

/** Negative when `a` comes before `b`, positive after, 0 when equal. */
export function compareCursors(a: string, b: string): number {
  const [sa, ka] = key(a)
  const [sb, kb] = key(b)
  return sa !== sb ? sa - sb : ka === kb ? 0 : ka < kb ? -1 : 1
}

/** The log `seq` a cursor points into. */
export function cursorSeq(cursor: string): number {
  return key(cursor)[0]
}
