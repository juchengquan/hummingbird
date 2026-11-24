/**
 * Q81: a task that hits its step limit delivers what it has, with a
 * visible note. agent-py marks it on the run's result
 * (`RunResult.stoppedAt: "max_steps"`, an extra key `RunResult` allows);
 * the Tasks panel shows the note on the task, and delivery appends it to
 * the delivered message (`withStepLimitNote`). Pure.
 */

/** The value of `RunResult.stoppedAt` for a run that ran out of steps. */
export const STOPPED_AT_MAX_STEPS = "max_steps"

/** Whether a succeeded run's result says it stopped at its step limit. */
export function stoppedAtStepLimit(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { stoppedAt?: unknown }).stoppedAt === STOPPED_AT_MAX_STEPS
  )
}

/** The note, as the panel shows it and the message ends with it. */
export function stepLimitNote(maxSteps: number | null | undefined): string {
  return maxSteps
    ? `Stopped at the step limit (${maxSteps} steps): this is what the task had by then.`
    : "Stopped at the step limit: this is what the task had by then."
}

/** The delivered message's text: the answer, then the note (once). */
export function withStepLimitNote(text: string, maxSteps: number | null | undefined): string {
  const note = stepLimitNote(maxSteps)
  if (text.includes(note)) return text
  const body = text.trimEnd()
  return body ? `${body}\n\n_${note}_` : `_${note}_`
}
