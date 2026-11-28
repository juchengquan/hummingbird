"use client"
import "client-only"

/**
 * ChoiceCard — N labelled options. Single-select resolves on a single
 * click (one button = the answer). Multi-select stages picks locally
 * and resolves on Submit.
 *
 * Inert state shows the picked option(s) highlighted; all buttons
 * are disabled.
 */

import { useState } from "react"

import { Button } from "@/components/ui/button"
import type {
  ChoiceProps,
  UiAnswer,
} from "@/shared/generative-ui/schemas"
import { cn } from "@/shared/utils"

import type { UiPartHostProps } from "@/client/chat/generative-ui/registry"

export function ChoiceCard({
  props,
  inert,
  answer,
  onResolve,
}: UiPartHostProps) {
  const p = props as ChoiceProps
  const multi = !!p.multiSelect

  const previouslyPicked =
    answer && answer.kind === "choice"
      ? new Set(
          (answer as Extract<UiAnswer, { kind: "choice" }>).selectedIds,
        )
      : new Set<string>()
  const [pending, setPending] = useState<Set<string>>(() => previouslyPicked)

  const toggle = (id: string) => {
    setPending((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submitSingle = (id: string) => {
    onResolve({ kind: "choice", selectedIds: [id] })
  }

  const submitMulti = () => {
    if (pending.size === 0) return
    // Preserve option order from the props so the formatted answer
    // text reads as the model expects.
    const ids = p.options.map((o) => o.id).filter((id) => pending.has(id))
    onResolve({ kind: "choice", selectedIds: ids })
  }

  return (
    <div
      className={cn(
        "my-3 rounded-lg border border-[var(--border)]",
        "bg-[var(--card)] text-[var(--card-foreground)]",
        "p-3 text-sm",
      )}
      aria-label="Choice"
    >
      <div className="mb-2 text-[var(--foreground)]">{p.prompt}</div>
      <div className="flex flex-wrap gap-1.5">
        {p.options.map((opt) => {
          const isPicked = multi
            ? pending.has(opt.id)
            : previouslyPicked.has(opt.id)
          return (
            <Button
              key={opt.id}
              type="button"
              size="sm"
              variant={isPicked ? "default" : "outline"}
              disabled={inert}
              onClick={() => (multi ? toggle(opt.id) : submitSingle(opt.id))}
              aria-pressed={multi ? isPicked : undefined}
            >
              {opt.label}
            </Button>
          )
        })}
      </div>
      {multi && !inert ? (
        <div className="mt-2">
          <Button
            type="button"
            size="sm"
            onClick={submitMulti}
            disabled={pending.size === 0}
          >
            Submit
          </Button>
        </div>
      ) : null}
    </div>
  )
}
