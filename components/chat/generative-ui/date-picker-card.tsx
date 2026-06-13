"use client"
import "client-only"

/**
 * DatePickerCard — single date (auto-resolves on pick) or a date range
 * (pick from→to, then Submit). Reuses the repo's `Calendar`
 * (react-day-picker). Dates are ISO `YYYY-MM-DD`, date-only. Inert
 * state shows the picked date(s) with the calendar disabled.
 */

import { useState } from "react"
import { format, parseISO } from "date-fns"
import type { DateRange } from "react-day-picker"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import type {
  DatePickerProps,
  UiAnswer,
} from "@/shared/generative-ui/schemas"
import { cn } from "@/shared/utils"

import type { UiPartHostProps } from "@/client/chat/generative-ui/registry"

const toIso = (d: Date): string => format(d, "yyyy-MM-dd")

export function DatePickerCard({
  props,
  inert,
  answer,
  onResolve,
}: UiPartHostProps) {
  const p = props as DatePickerProps
  const dp = answer && answer.kind === "date-picker" ? answer : null

  // min/max bound the calendar — out-of-range days are disabled.
  const disabledMatchers = [
    ...(p.min ? [{ before: parseISO(p.min) }] : []),
    ...(p.max ? [{ after: parseISO(p.max) }] : []),
  ]

  const prevSingle = dp && "date" in dp ? parseISO(dp.date) : undefined
  const prevRange: DateRange | undefined =
    dp && "from" in dp
      ? { from: parseISO(dp.from), to: parseISO(dp.to) }
      : undefined

  const [range, setRange] = useState<DateRange | undefined>(() => prevRange)

  const card = (children: React.ReactNode) => (
    <div
      className={cn(
        "my-3 rounded-lg border border-[var(--border)]",
        "bg-[var(--card)] text-[var(--card-foreground)]",
        "p-3 text-sm",
      )}
      aria-label="Date picker"
    >
      <div className="mb-2 text-[var(--foreground)]">{p.prompt}</div>
      {children}
    </div>
  )

  if (p.mode === "range") {
    return card(
      <>
        <Calendar
          mode="range"
          selected={range}
          onSelect={inert ? undefined : (r?: DateRange) => setRange(r)}
          disabled={inert ? true : disabledMatchers}
        />
        {!inert ? (
          <div className="mt-2">
            <Button
              type="button"
              size="sm"
              disabled={!range?.from || !range?.to}
              onClick={() => {
                if (range?.from && range?.to) {
                  onResolve({
                    kind: "date-picker",
                    from: toIso(range.from),
                    to: toIso(range.to),
                  } satisfies Extract<UiAnswer, { kind: "date-picker" }>)
                }
              }}
            >
              Submit
            </Button>
          </div>
        ) : null}
      </>,
    )
  }

  return card(
    <Calendar
      mode="single"
      selected={prevSingle}
      onSelect={
        inert
          ? undefined
          : (d?: Date) => {
              if (d) onResolve({ kind: "date-picker", date: toIso(d) })
            }
      }
      disabled={inert ? true : disabledMatchers}
    />,
  )
}
