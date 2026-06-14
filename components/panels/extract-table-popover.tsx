"use client"
import "client-only"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/** Chip-list picker for the "Extract to table" action. Pre-seeds chips
 *  from the report's source titles (deduped, slugified, capped at 8).
 *  User can remove chips, type a new chip + Enter, or click "Run
 *  extraction" / "Let the model decide". The latter submits with no
 *  hints (preserves today's "I just want to extract" path). The popover
 *  is purely a UI shell; it does not call the API itself — it delegates
 *  to `onRun(hints)` on Run and `onRun(undefined)` on "Let the model
 *  decide". */
export function ExtractTablePopover({
  sourceTitles,
  extracting,
  onRun,
  trigger,
}: {
  sourceTitles: string[]
  extracting: boolean
  onRun: (hints: string[] | undefined) => void
  trigger: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [chips, setChips] = useState<string[]>(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const t of sourceTitles) {
      const slug = t.trim().slice(0, 60)
      const key = slug.toLowerCase()
      if (!slug || seen.has(key)) continue
      seen.add(key)
      out.push(slug)
      if (out.length >= 8) break
    }
    return out
  })
  const [draft, setDraft] = useState("")

  const addChip = (raw: string) => {
    const value = raw.trim().slice(0, 60)
    if (!value) return
    if (chips.length >= 8) return
    if (chips.some((c) => c.toLowerCase() === value.toLowerCase())) return
    setChips([...chips, value])
    setDraft("")
  }
  const removeChip = (i: number) => setChips(chips.filter((_, idx) => idx !== i))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-80 text-xs" align="end" side="bottom">
        <div className="space-y-2">
          <p className="font-medium">Steer the columns</p>
          <p className="text-[var(--muted-foreground)]">
            Pick or type the column names. Empty = let the model decide.
          </p>
          <div className="flex flex-wrap gap-1 rounded border border-[var(--border)] p-1.5">
            {chips.length === 0 ? (
              <span className="text-[var(--muted-foreground)]">No chips — model decides.</span>
            ) : (
              chips.map((c, i) => (
                <span
                  key={`${c}-${i}`}
                  className="inline-flex items-center gap-1 rounded bg-[var(--muted)] px-1.5 py-0.5"
                >
                  {c}
                  <button
                    type="button"
                    aria-label={`Remove ${c}`}
                    onClick={() => removeChip(i)}
                    className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addChip(draft)
              }
            }}
            placeholder="Add a column name + Enter"
            maxLength={60}
            className="h-7 text-xs"
            disabled={chips.length >= 8}
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onRun(undefined)
                setOpen(false)
              }}
              disabled={extracting}
            >
              Let the model decide
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onRun(chips)
                setOpen(false)
              }}
              disabled={extracting || chips.length === 0}
            >
              {extracting ? "Extracting…" : "Run extraction"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
