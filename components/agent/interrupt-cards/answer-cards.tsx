"use client"

/**
 * The answer cards: what a paused agent asks the human — approve a tool
 * call, pick an option, type an answer, or fill a generative-UI part —
 * rendered from an `AnswerQuestion` and answered with a `CardAnswer`
 * (`lib/shared/agent/answer-cards.ts`). Shared by the task strip (answers
 * go to `/api/tasks/:id/respond`) and chat on runs (answers resume the
 * run — `components/chat/interrupted-turn-cards.tsx`).
 *
 * The cards only collect the answer; the caller sends it, and passes
 * `busy` while it does (every control is then disabled).
 */

import { useId, useState, type KeyboardEvent } from "react"

import { Check, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { getUiKindDef } from "@/client/chat/generative-ui/registry"
import {
  canSubmitSelection,
  canSubmitValue,
  formatToolArgs,
  toggleSelection,
  type AnswerQuestion,
  type CardAnswer,
} from "@/shared/agent/answer-cards"
import type { UiAnswer, UiKind } from "@/shared/generative-ui/schemas"

export interface AnswerCardProps {
  question: AnswerQuestion
  /** An answer is being sent: every control is disabled. */
  busy: boolean
  onAnswer: (answer: CardAnswer) => void
}

const CARD_CLASS =
  "rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/5 p-2"

/** The card for `question.reason`. */
export function AnswerCard(props: AnswerCardProps & { uiAnswer?: UiAnswer }) {
  switch (props.question.reason) {
    case "ui-part":
      return <UiPartAnswerCard {...props} />
    case "choice":
      return <ChoiceAnswerCard {...props} />
    case "input":
      return <InputAnswerCard {...props} />
    case "approval":
      return <ApprovalAnswerCard {...props} />
  }
}

/** "Approve / Reject" for an approval-gated tool call. */
export function ApprovalAnswerCard({ question, busy, onAnswer }: AnswerCardProps) {
  const titleId = useId()
  const args = formatToolArgs(question.args)
  return (
    <div role="group" aria-labelledby={titleId} className={`${CARD_CLASS} space-y-2`}>
      <div className="text-xs">
        <p id={titleId} className="font-medium">
          Approve action?
        </p>
        {/* The interrupt's own question (a run's `message`), when it has one. */}
        {question.prompt ? <p>{question.prompt}</p> : null}
        <p className="text-[var(--muted-foreground)]">
          The agent wants to call <code>{question.tool}</code>.
        </p>
        {args ? (
          <pre
            aria-label="Tool arguments"
            className="mt-1 max-h-32 overflow-auto rounded bg-[var(--background)] p-1.5 text-[10px]"
          >
            {args}
          </pre>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          size="xs"
          variant="default"
          disabled={busy}
          onClick={() => onAnswer({ approved: true })}
        >
          <Check />
          Approve
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => onAnswer({ approved: false })}
        >
          <X />
          Reject
        </Button>
      </div>
    </div>
  )
}

/** Pick one (radio) or several (checkbox) of the options, then Submit. */
export function ChoiceAnswerCard({ question, busy, onAnswer }: AnswerCardProps) {
  const promptId = useId()
  const options = question.options ?? []
  const multi = !!question.multi
  const [selected, setSelected] = useState<string[]>([])
  const canSubmit = canSubmitSelection(selected) && !busy
  return (
    <form
      aria-labelledby={promptId}
      className={`${CARD_CLASS} space-y-2`}
      onSubmit={(e) => {
        e.preventDefault()
        if (canSubmit) onAnswer({ selection: selected })
      }}
    >
      <p id={promptId} className="text-xs">
        {question.prompt ?? "Pick one:"}
      </p>
      <ul role={multi ? "group" : "radiogroup"} aria-labelledby={promptId} className="space-y-1">
        {options.map((opt) => {
          const checked = selected.includes(opt.id)
          return (
            <li key={opt.id}>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type={multi ? "checkbox" : "radio"}
                  name={`choice-${question.id}`}
                  checked={checked}
                  onChange={() => setSelected((prev) => toggleSelection(prev, opt.id, multi))}
                  disabled={busy}
                />
                <span>{opt.label}</span>
              </label>
            </li>
          )
        })}
      </ul>
      <Button type="submit" size="xs" variant="default" disabled={!canSubmit}>
        <Check />
        Submit
      </Button>
    </form>
  )
}

/** Free-text answer; ⌘/Ctrl+Enter submits. */
export function InputAnswerCard({ question, busy, onAnswer }: AnswerCardProps) {
  const promptId = useId()
  const [value, setValue] = useState("")
  const canSubmit = canSubmitValue(value) && !busy
  const submit = () => {
    if (canSubmit) onAnswer({ value })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <form
      aria-labelledby={promptId}
      className={`${CARD_CLASS} space-y-2`}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <p id={promptId} className="text-xs">
        {question.prompt ?? "Your input:"}
      </p>
      <textarea
        aria-labelledby={promptId}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={busy}
        rows={3}
        className="w-full rounded border border-[var(--border)] bg-[var(--background)] p-1.5 text-xs"
        placeholder="Type your answer…"
      />
      <Button
        type="submit"
        size="xs"
        variant="default"
        disabled={!canSubmit}
        aria-keyshortcuts="Meta+Enter Control+Enter"
      >
        <Check />
        Submit
      </Button>
    </form>
  )
}

/**
 * A `renderUI` part as the card — the chat-mode generative-UI component
 * from the registry (`lib/client/chat/generative-ui/registry.ts`), so the
 * presentational core stays in one place. With `uiAnswer` it renders
 * inert, showing that answer.
 */
export function UiPartAnswerCard({
  question,
  busy,
  onAnswer,
  uiAnswer,
}: AnswerCardProps & { uiAnswer?: UiAnswer }) {
  const def = question.uiKind ? getUiKindDef(question.uiKind) : null
  // Defensive: the server validated, but a stale client across a deploy
  // window might see an unknown kind — explain rather than crash.
  if (!def) {
    return (
      <div role="group" aria-label="Generative UI input" className={`${CARD_CLASS} text-xs`}>
        <p className="font-medium">Generative UI input</p>
        <p className="text-[var(--muted-foreground)]">
          (unknown kind <code>{question.uiKind ?? "—"}</code>; update the
          client to render this.)
        </p>
      </div>
    )
  }
  const parsed = def.schema.safeParse(question.uiProps)
  if (!parsed.success) {
    return (
      <div role="group" aria-label="Generative UI input" className={`${CARD_CLASS} text-xs`}>
        <p className="font-medium">Generative UI input</p>
        <p className="text-[var(--muted-foreground)]">
          (props validation failed; the agent runner may have emitted
          a malformed payload.)
        </p>
      </div>
    )
  }
  const Component = def.Component
  const inert = busy || uiAnswer !== undefined
  const handleResolve = (answer: UiAnswer) => {
    if (inert) return
    onAnswer({
      uiAnswer: answer,
      part: { kind: question.uiKind as UiKind, props: parsed.data },
    })
  }
  return (
    <div className={CARD_CLASS}>
      <Component props={parsed.data} inert={inert} answer={uiAnswer} onResolve={handleResolve} />
    </div>
  )
}

/** True when the card can't answer `question` (unknown generative-UI kind
 *  or props that fail validation) — the caller may then offer a dismiss. */
export function isUnrenderableUiPart(question: AnswerQuestion): boolean {
  if (question.reason !== "ui-part") return false
  const def = question.uiKind ? getUiKindDef(question.uiKind) : null
  return !def || !def.schema.safeParse(question.uiProps).success
}
