"use client"

/**
 * One open question of a task on runs: the task's own (answered by a
 * resume) or a sub-agent's (answered in place, Q59). The same answer
 * cards as the old strip and chat (`AnswerCard`), every input kind; an
 * answer is `tasks.answer`. Once it is accepted the card says so until a
 * worker picks it up (`answerPending`), and a refusal that means the
 * question moved on says that plainly.
 */

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { useTasks } from "@/client/runs/tasks/context"
import type { TaskQuestion } from "@/client/runs/tasks/types"
import {
  interruptAnswerFor,
  isInterruptExpired,
  msUntilNextExpiry,
  questionFromInterrupt,
  type DraftAnswer,
} from "@/client/runs/interrupt-answers"

import { AnswerCard } from "../interrupt-cards/answer-cards"

import { answerRefusal } from "./phase"

type Sent =
  | { phase: "sending" }
  | { phase: "sent" }
  | { phase: "failed"; text: string }
  | { phase: "stale"; text: string }

export function TaskQuestionCard({ question }: { question: TaskQuestion }) {
  const tasks = useTasks()
  const [sent, setSent] = useState<Sent | null>(null)
  // Re-render when the question expires: it can then only be dismissed.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const wait = msUntilNextExpiry([question.interrupt], now)
    if (wait === null) return
    const timer = setTimeout(() => setNow(Date.now()), wait + 50)
    return () => clearTimeout(timer)
  }, [question.interrupt, now])

  if (question.answerPending || sent?.phase === "sent") {
    return (
      <p aria-live="polite" className="text-xs text-[var(--muted-foreground)]">
        Answer sent. Waiting for the task to continue…
      </p>
    )
  }
  if (sent?.phase === "stale") {
    return (
      <p aria-live="polite" className="text-xs text-[var(--muted-foreground)]">
        {sent.text}
      </p>
    )
  }

  const send = async (draft: DraftAnswer) => {
    setSent({ phase: "sending" })
    try {
      const result = await tasks.answer(question, interruptAnswerFor(draft))
      if (result.ok) {
        setSent({ phase: "sent" })
        return
      }
      const refusal = answerRefusal(result.code, result.message)
      setSent(refusal.stale ? { phase: "stale", text: refusal.text } : { phase: "failed", text: refusal.text })
      if (refusal.stale) tasks.refresh()
    } catch (err) {
      setSent({ phase: "failed", text: `Couldn't send your answer: ${(err as Error).message}` })
    }
  }

  const card = questionFromInterrupt(question.interrupt)
  const expired = isInterruptExpired(question.interrupt, now)
  const busy = sent?.phase === "sending"

  return (
    <div className="space-y-1 break-words">
      {card && !expired ? (
        <AnswerCard question={card} busy={busy} onAnswer={(given) => void send(given)} />
      ) : (
        <div className="rounded-md border border-[var(--border)] p-2 text-xs space-y-1.5">
          <p>
            {expired
              ? "This question has expired. Dismiss it to let the task carry on."
              : "This question can't be answered here. Dismiss it to let the task carry on."}
          </p>
          {question.interrupt.message ? (
            <p className="text-[var(--muted-foreground)]">{question.interrupt.message}</p>
          ) : null}
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void send({ cancelled: true })}>
            Dismiss
          </Button>
        </div>
      )}
      {sent?.phase === "failed" ? (
        <p role="alert" className="text-xs text-[var(--destructive)]">
          {sent.text}
        </p>
      ) : null}
    </div>
  )
}
