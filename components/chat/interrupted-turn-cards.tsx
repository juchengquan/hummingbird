"use client"
import "client-only"

/**
 * Chat on runs (Q35): the answer cards under an assistant message whose
 * run paused on interrupts — one card per open interrupt, the same cards
 * as the task strip (`components/agent/interrupt-cards/`). Once every
 * interrupt has an answer, they go to the chat run bridge
 * (`getChatRunBridge().answerInterrupts`, wave 4b-A), which resumes the
 * run into the same message. Lifecycle (`chat-bridge.ts`): the cards show
 * "Sending your answer…" until the resume run starts; then the bridge
 * writes the answered generative-UI parts to the message and clears the
 * turn, so the cards unmount and the answer streams into the message. A
 * refusal before the start comes back here:
 *
 * - `run_already_resumed` → "answered elsewhere"; the run is re-read, and
 *   a run that moved on loses its card + pointer.
 * - `run_answer_applied` (Q63) → an earlier answer was acted on and its
 *   run ended: the runner drops the turn (these cards go) and puts the
 *   "already acted on" bubble on the message, whose Retry resends it.
 * - `invalid_state` → "this question expired", with an offer to resend
 *   the user's message.
 * - any other failure → inline error; Retry resends the same answers.
 * - an interrupt past `expiresAt` (or of a reason this client can't
 *   answer) can only be dismissed (`{ cancelled: true }`).
 * - no bridge yet (chat still mounting) → disabled, with a hint.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { Loader2, RotateCcw, Send, X } from "lucide-react"

import {
  AnswerCard,
  isUnrenderableUiPart,
} from "@/components/agent/interrupt-cards/answer-cards"
import { Button } from "@/components/ui/button"
import { apiClient } from "@/client/api-client"
import { resolveRunsTarget } from "@/client/api/backend-resolver"
import { useStore } from "@/client/hooks/use-store"
import { clearActiveRun } from "@/client/runs/active-run"
import {
  getChatRunBridge,
  useInterruptedTurn,
  useInterruptedTurns,
  type InterruptedTurn,
} from "@/client/runs/chat-bridge"
import {
  describeDraft,
  isInterruptExpired,
  msUntilNextExpiry,
  questionFromInterrupt,
  recheckAnsweredRun,
  resumeAnswers,
  submitTurnAnswers,
  type AnswerFailure,
  type DraftAnswer,
} from "@/client/runs/interrupt-answers"
import type { PendingInterrupt } from "@/client/runs/interrupts"
import type { CardAnswer } from "@/shared/agent/answer-cards"

/** The active conversation's interrupted turn, when it pauses `messageId`. */
export function useMessageInterruptedTurn(messageId: string): InterruptedTurn | undefined {
  const conversationId = useStore((s) => s.activeConversationId)
  const turn = useInterruptedTurn(conversationId)
  return turn && turn.messageId === messageId ? turn : undefined
}

interface InterruptedTurnCardsProps {
  turn: InterruptedTurn
  /** Resend the user's message that started the turn (after the run
   *  expired); absent → only "Dismiss" is offered. */
  onResend?: () => void
}

export function InterruptedTurnCards(props: InterruptedTurnCardsProps) {
  // A further interrupt replaces the turn (new run id): start over.
  return <TurnCards key={props.turn.runId} {...props} />
}

type Phase =
  | { type: "answering" }
  | { type: "sending" }
  /** Answered; the bridge has moved the turn on (this card is going away). */
  | { type: "sent" }
  | ({ type: "failed" } & AnswerFailure)

const BRIDGE_POLL_MS = 500

function TurnCards({ turn, onResend }: InterruptedTurnCardsProps) {
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({})
  const [phase, setPhase] = useState<Phase>({ type: "answering" })
  const [bridgeReady, setBridgeReady] = useBridgeReady()
  const now = useExpiryClock(turn.interrupts)
  const retryRef = useRef<HTMLButtonElement>(null)

  const forget = useCallback(() => {
    useInterruptedTurns.getState().clearInterruptedTurn(turn.conversationId, turn.runId)
    clearActiveRun(turn.conversationId, turn.runId)
  }, [turn.conversationId, turn.runId])

  const send = useCallback(
    async (all: Record<string, DraftAnswer>) => {
      if (!resumeAnswers(turn.interrupts, all)) return
      setPhase({ type: "sending" })
      const outcome = await submitTurnAnswers(turn, all, getChatRunBridge())
      switch (outcome.type) {
        case "incomplete":
          setPhase({ type: "answering" })
          return
        case "no-bridge":
          // Chat unmounted meanwhile: wait for it, then send (effect below).
          setPhase({ type: "answering" })
          setBridgeReady(false)
          return
        case "answered":
          // The bridge wrote the answered parts and cleared the turn when
          // the resume started (these cards are unmounted by now); the
          // clear is only a backstop.
          useInterruptedTurns.getState().clearInterruptedTurn(turn.conversationId, turn.runId)
          setPhase({ type: "sent" })
          return
        case "failed":
          setPhase({ type: "failed", ...outcome.failure })
          if (outcome.failure.kind === "answered-elsewhere") void recheckRun(turn)
          return
      }
    },
    [turn, setBridgeReady],
  )

  const answer = (interruptId: string, draft: DraftAnswer) => {
    if (phase.type !== "answering") return
    const next = { ...drafts, [interruptId]: draft }
    setDrafts(next)
    if (resumeAnswers(turn.interrupts, next)) void send(next)
  }
  const change = (interruptId: string) => {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[interruptId]
      return next
    })
    setPhase({ type: "answering" })
  }

  useEffect(() => {
    if (phase.type === "failed" && phase.kind === "error") retryRef.current?.focus()
  }, [phase])

  // Every interrupt answered while chat wasn't ready: send once it is.
  useEffect(() => {
    if (bridgeReady && phase.type === "answering" && resumeAnswers(turn.interrupts, drafts)) {
      void send(drafts)
    }
    // Only on the bridge appearing — answers themselves send directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeReady])

  const sending = phase.type === "sending" || phase.type === "sent"
  const locked = sending || phase.type === "failed" || !bridgeReady
  const answeredCount = turn.interrupts.filter((i) => drafts[i.id]).length

  return (
    <section
      aria-label="The assistant is waiting for your answer"
      className="mt-2 space-y-2"
    >
      {turn.interrupts.map((interrupt) => (
        <InterruptSlot
          key={interrupt.id}
          interrupt={interrupt}
          draft={drafts[interrupt.id]}
          expired={isInterruptExpired(interrupt, now)}
          locked={locked}
          canChange={phase.type === "answering" || (phase.type === "failed" && phase.kind === "error")}
          onAnswer={(draft) => answer(interrupt.id, draft)}
          onChange={() => change(interrupt.id)}
        />
      ))}

      <div role="status" aria-live="polite" className="text-xs text-[var(--muted-foreground)]">
        {sending ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" />
            Sending your answer…
          </span>
        ) : !bridgeReady && phase.type === "answering" ? (
          <span>Chat is still loading — you can answer in a moment.</span>
        ) : phase.type === "answering" ? (
          <span>
            {turn.interrupts.length > 1
              ? `${answeredCount} of ${turn.interrupts.length} answered — the answers are sent together. `
              : ""}
            Or send a new message to skip this question.
          </span>
        ) : phase.kind === "answered-elsewhere" ? (
          <span>This question was already answered in another tab or window.</span>
        ) : phase.kind === "expired" ? (
          <span>This question expired before it was answered.</span>
        ) : phase.kind === "applied" ? (
          <span>This answer was already acted on, so it can&apos;t be sent again.</span>
        ) : null}
      </div>

      {phase.type === "failed" && phase.kind === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[var(--destructive)]">
            Couldn&apos;t send your answer: {phase.message}
          </span>
          <Button ref={retryRef} size="xs" variant="outline" onClick={() => void send(drafts)}>
            <RotateCcw />
            Retry
          </Button>
        </div>
      ) : null}

      {phase.type === "failed" && (phase.kind === "expired" || phase.kind === "applied") ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {onResend ? (
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                forget()
                onResend()
              }}
            >
              <Send />
              Resend message
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={forget}>
            <X />
            Dismiss
          </Button>
        </div>
      ) : null}

      {phase.type === "failed" && phase.kind === "answered-elsewhere" ? (
        <Button size="xs" variant="ghost" onClick={forget}>
          <X />
          Dismiss
        </Button>
      ) : null}
    </section>
  )
}

/** One interrupt: its card, what was answered (before sending), or — for
 *  an expired / unanswerable one — a dismiss. */
function InterruptSlot({
  interrupt,
  draft,
  expired,
  locked,
  canChange,
  onAnswer,
  onChange,
}: {
  interrupt: PendingInterrupt
  draft: DraftAnswer | undefined
  expired: boolean
  locked: boolean
  canChange: boolean
  onAnswer: (draft: DraftAnswer) => void
  onChange: () => void
}) {
  const question = questionFromInterrupt(interrupt)
  const cancelled = !!draft && "cancelled" in draft

  if (draft && (cancelled || (!expired && question && !("uiAnswer" in draft)))) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-2 py-1.5 text-xs">
        <span className="text-[var(--muted-foreground)]">
          {question?.reason === "approval" && question.tool ? (
            <>
              <code>{question.tool}</code>:{" "}
            </>
          ) : question?.prompt ? (
            `${question.prompt} `
          ) : null}
        </span>
        <span className="font-medium">{describeDraft(question, draft)}</span>
        {canChange && !cancelled ? (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={onChange}>
            Change
          </Button>
        ) : null}
      </div>
    )
  }

  if (!question || expired) {
    return (
      <div
        role="group"
        aria-label={expired ? "Expired question" : "Unsupported question"}
        className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-2 py-1.5 text-xs"
      >
        <span className="text-[var(--muted-foreground)]">
          {interrupt.message ? <>&ldquo;{interrupt.message}&rdquo; </> : null}
          {expired
            ? "This question expired and can only be dismissed."
            : "This question can't be answered here."}
        </span>
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={locked}
          onClick={() => onAnswer({ cancelled: true })}
        >
          <X />
          Dismiss
        </Button>
      </div>
    )
  }

  const uiDraft = draft && "uiAnswer" in draft ? draft : undefined
  const unrenderable = isUnrenderableUiPart(question)
  const readOnlyPart = question.reason === "ui-part" && question.uiKind === "info-table"
  return (
    <div className="space-y-1">
      <AnswerCard
        question={question}
        busy={locked}
        uiAnswer={uiDraft?.uiAnswer}
        onAnswer={(a: CardAnswer) => onAnswer(a)}
      />
      {unrenderable ? (
        <Button size="xs" variant="outline" disabled={locked} onClick={() => onAnswer({ cancelled: true })}>
          <X />
          Dismiss
        </Button>
      ) : readOnlyPart && !uiDraft ? (
        <Button
          size="xs"
          variant="outline"
          disabled={locked}
          onClick={() =>
            onAnswer({
              uiAnswer: { kind: "info-table" },
              part: { kind: "info-table", props: question.uiProps },
            })
          }
        >
          Continue
        </Button>
      ) : uiDraft && canChange ? (
        <Button size="xs" variant="ghost" onClick={onChange}>
          Change
        </Button>
      ) : null}
    </div>
  )
}

/** After `run_already_resumed`: a run the backend forgot, or that is no
 *  longer waiting, loses its card and pointer. One still `interrupted`
 *  (the usual case — the answered run keeps that status while the other
 *  tab's resume continues the turn) keeps the notice until dismissed. */
async function recheckRun(turn: InterruptedTurn): Promise<void> {
  const target = await resolveRunsTarget()
  if (!target) return
  const state = await recheckAnsweredRun(turn.runId, (runId) =>
    apiClient.runs.status(runId, { target }),
  )
  if (state !== "gone") return
  useInterruptedTurns.getState().clearInterruptedTurn(turn.conversationId, turn.runId)
  clearActiveRun(turn.conversationId, turn.runId)
}

/** Whether the chat run bridge is registered (4b-A registers it when chat
 *  mounts); polled, since registration isn't observable. */
function useBridgeReady(): [boolean, (ready: boolean) => void] {
  const [ready, setReady] = useState(() => getChatRunBridge() !== null)
  useEffect(() => {
    if (ready) return
    const timer = setInterval(() => {
      if (getChatRunBridge()) setReady(true)
    }, BRIDGE_POLL_MS)
    return () => clearInterval(timer)
  }, [ready])
  return [ready, setReady]
}

/** `Date.now()`, refreshed when the next of these interrupts expires. */
function useExpiryClock(interrupts: readonly PendingInterrupt[]): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const wait = msUntilNextExpiry(interrupts, now)
    if (wait === null) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [interrupts, now])
  return now
}
