/**
 * Pure helper used by SubagentGroup in task-strip.tsx.
 * Returns the status string for a child task, defaulting to "queued"
 * when no status has been fetched yet. A cancelled child of a live
 * parent was skipped (Q60).
 */
export function subagentPillLabel(
  childTaskId: string,
  statuses: Record<string, string>
): string {
  const status = statuses[childTaskId] ?? "queued"
  return status === "cancelled" ? "skipped" : status
}
