/**
 * Pure helper used by SubagentGroup in task-strip.tsx.
 * Returns the status string for a child task, defaulting to "queued"
 * when no status has been fetched yet.
 */
export function subagentPillLabel(
  childTaskId: string,
  statuses: Record<string, string>
): string {
  return statuses[childTaskId] ?? "queued"
}
