"use client"
import "client-only"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { Citation, CitationTable } from "@/shared/artifacts/citation-table"

type Sources = CitationTable["sources"]

/** Editable citation list for a single cell (editable mode only). Each
 *  existing citation is a `[n]` chip whose popover is a small form
 *  (source <select> + quote <textarea> + Remove). A `+ cite` trigger
 *  adds a new citation. Source choices are limited to the table's
 *  existing `sources`. Read-only rendering stays in CitationChips. */
export function CitationCellEditor({
  sources,
  citations,
  onAdd,
  onUpdate,
  onRemove,
}: {
  sources: Sources
  citations: Citation[]
  onAdd: (citation: Citation) => void
  onUpdate: (citIndex: number, patch: Partial<Citation>) => void
  onRemove: (citIndex: number) => void
}) {
  return (
    <>
      {citations.map((c, i) => {
        const idx = sources.findIndex((s) => s.id === c.sourceId)
        return (
          <EditCitationPopover
            key={`cit-${i}`}
            sources={sources}
            citation={c}
            label={idx === -1 ? "?" : String(idx + 1)}
            onUpdate={(patch) => onUpdate(i, patch)}
            onRemove={() => onRemove(i)}
          />
        )
      })}
      {sources.length > 0 && citations.length < 8 ? (
        <AddCitationPopover sources={sources} onAdd={onAdd} />
      ) : null}
    </>
  )
}

function SourceSelect({
  sources,
  value,
  ariaLabel,
  onChange,
}: {
  sources: Sources
  value: string
  ariaLabel: string
  onChange: (sourceId: string) => void
}) {
  const known = sources.some((s) => s.id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-1 text-xs"
    >
      {!known ? (
        <option value={value} disabled>
          (unknown source)
        </option>
      ) : null}
      {sources.map((s, i) => (
        <option key={s.id} value={s.id}>
          [{i + 1}] {s.title}
        </option>
      ))}
    </select>
  )
}

function EditCitationPopover({
  sources,
  citation,
  label,
  onUpdate,
  onRemove,
}: {
  sources: Sources
  citation: Citation
  label: string
  onUpdate: (patch: Partial<Citation>) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [quoteDraft, setQuoteDraft] = useState(citation.quote)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setQuoteDraft(citation.quote)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Edit citation ${label}`}
          className="ml-0.5 align-super text-[10px] text-[var(--primary)] hover:underline"
        >
          [{label}]
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 text-xs">
        <label className="block">
          <span className="mb-1 block text-[var(--muted-foreground)]">Source</span>
          <SourceSelect
            sources={sources}
            value={citation.sourceId}
            ariaLabel="Citation source"
            onChange={(sourceId) => onUpdate({ sourceId })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[var(--muted-foreground)]">Quote</span>
          <textarea
            value={quoteDraft}
            onChange={(e) => setQuoteDraft(e.target.value)}
            onBlur={() => {
              if (quoteDraft !== citation.quote) onUpdate({ quote: quoteDraft })
            }}
            maxLength={2000}
            rows={3}
            aria-label="Citation quote"
            className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-1 text-xs"
          />
        </label>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onRemove()
              setOpen(false)
            }}
            className="h-6 text-xs text-[var(--destructive)]"
          >
            Remove
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function AddCitationPopover({
  sources,
  onAdd,
}: {
  sources: Sources
  onAdd: (citation: Citation) => void
}) {
  const [open, setOpen] = useState(false)
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "")
  const [quote, setQuote] = useState("")

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setSourceId(sources[0]?.id ?? "")
          setQuote("")
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Add citation"
          className="ml-1 align-super text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:underline"
        >
          + cite
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 text-xs">
        <label className="block">
          <span className="mb-1 block text-[var(--muted-foreground)]">Source</span>
          <SourceSelect
            sources={sources}
            value={sourceId}
            ariaLabel="New citation source"
            onChange={setSourceId}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[var(--muted-foreground)]">Quote</span>
          <textarea
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            maxLength={2000}
            rows={3}
            aria-label="New citation quote"
            className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-1 text-xs"
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            className="h-6 text-xs"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!sourceId}
            onClick={() => {
              if (!sourceId) return
              onAdd({ sourceId, quote })
              setOpen(false)
            }}
            className="h-6 text-xs"
          >
            Add
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
