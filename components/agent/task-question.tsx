"use client"

import { useEffect, useState } from "react"

import { sendTaskAnswer, useTaskAnswer } from "@/client/agent/answers"
import {
  questionFromPendingInput,
  respondBodyForCardAnswer,
} from "@/shared/agent/answer-cards"
import type { PendingInput } from "@/shared/agent/project"

import { AnswerCard } from "./interrupt-cards/answer-cards"

/** How long a sent answer may go unclaimed before the card comes back: a
 *  worker that never applied it leaves the task paused on the question,
 *  and only answering again moves it (Q57). */
const UNCLAIMED_AFTER_MS = 60_000

/**
 * The answer card for a run paused on `input` — the parent's own question
 * or a sub-agent's (then `runId` is the child's). The answer goes to
 * `/api/tasks/:runId/respond`.
 */
export function TaskQuestion({
  runId,
  input,
  onStale,
}: {
  runId: string
  input: PendingInput
  /** The question turned out to be closed: re-read the task. */
  onStale?: () => void
}) {
  const answer = useTaskAnswer(runId, input.requestId)
  const sentAt = answer && "at" in answer ? answer.at : null
  const unclaimed = usePassed(sentAt, UNCLAIMED_AFTER_MS)

  if (answer && sentAt !== null && !unclaimed) {
    return (
      <p aria-live="polite" className="text-xs text-[var(--muted-foreground)]">
        {answer.phase === "elsewhere"
          ? "This question was answered elsewhere or is no longer open."
          : "Answer sent. Waiting for the task to continue…"}
      </p>
    )
  }

  return (
    <div className="space-y-1 break-words">
      {unclaimed ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          The task hasn&apos;t picked up an answer yet. You can answer again.
        </p>
      ) : null}
      <AnswerCard
        question={questionFromPendingInput(input)}
        busy={answer?.phase === "sending"}
        onAnswer={(given) =>
          void sendTaskAnswer(runId, respondBodyForCardAnswer(input.requestId, given), onStale)
        }
      />
      {answer?.phase === "failed" ? (
        <p role="alert" className="text-xs text-[var(--destructive)]">
          Couldn&apos;t send your answer: {answer.message}
        </p>
      ) : null}
    </div>
  )
}

/** Whether `ms` have passed since `since`. */
function usePassed(since: number | null, ms: number): boolean {
  const [passedFor, setPassedFor] = useState<number | null>(null)
  useEffect(() => {
    if (since === null) return
    const timer = setTimeout(() => setPassedFor(since), Math.max(0, since + ms - Date.now()))
    return () => clearTimeout(timer)
  }, [since, ms])
  return since !== null && passedFor === since
}
