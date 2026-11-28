"use client"
import "client-only"

/**
 * Table header for a citation-table artifact. Owns all header-local
 * state and behavior: the per-column sort toggle (▲/▼ + aria-sort),
 * the column type pill Popover (text "Aa" / number "#"), drag-reorder
 * (grip ⠿ + drop-target highlight), the remove-column ×, the add-column
 * + button, and the add-column Dialog (label + type radios). Sort state
 * is owned by the parent View and threaded through `sort`/`onSortChange`;
 * every data mutation is delegated to a mutator-bound callback prop.
 * Pure structural extraction from CitationTableView — zero behavior
 * change. Returns a fragment (header <tr> + the portaled Dialog), safe
 * to render inside the parent's <thead>.
 */

import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { ColumnType } from "@/shared/artifacts/column-type"
import {
  COLUMN_TYPES,
  COLUMN_TYPE_GLYPHS,
  COLUMN_TYPE_LABELS,
  resolveColumnType,
} from "@/shared/artifacts/column-type"
import {
  type CitationTable,
  type CitationTableSort,
  slugifyColumnId,
  uniqueColumnId,
} from "@/shared/artifacts/citation-table"

export function CitationTableHeader({
  data,
  sort,
  onSortChange,
  editable,
  onSetColumnType,
  onRemoveColumn,
  onAddColumn,
  onColumnDrop,
}: {
  data: CitationTable
  sort: CitationTableSort | null
  onSortChange: (sort: CitationTableSort | null) => void
  editable: boolean
  onSetColumnType: (columnId: string, type: ColumnType) => void
  onRemoveColumn: (columnId: string) => void
  onAddColumn: (label: string, columnId: string, type: ColumnType) => void
  onColumnDrop: (from: number, to: number) => void
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [typePopoverColId, setTypePopoverColId] = useState<string | null>(null)
  const [addColOpen, setAddColOpen] = useState(false)
  const [newColLabel, setNewColLabel] = useState("")
  const [newColType, setNewColType] = useState<ColumnType>("text")

  const toggleSort = (columnId: string) =>
    onSortChange(
      sort && sort.columnId === columnId
        ? { columnId, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { columnId, dir: "asc" },
    )

  const submitAddColumn = () => {
    const label = newColLabel.trim().slice(0, 120)
    if (!label) return
    const columnId = uniqueColumnId(data, slugifyColumnId(label))
    onAddColumn(label, columnId, newColType)
    setNewColLabel("")
    setNewColType("text")
    setAddColOpen(false)
  }

  return (
    <>
      <tr>
        {data.columns.map((col, colIndex) => {
          const active = sort?.columnId === col.id
          const colType = resolveColumnType(col)
          return (
            <th
              key={col.id}
              scope="col"
              aria-sort={
                active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
              }
              onDragOver={
                editable
                  ? (e) => {
                      e.preventDefault()
                      setDragOver(colIndex)
                    }
                  : undefined
              }
              onDrop={
                editable
                  ? (e) => {
                      e.preventDefault()
                      if (dragFrom !== null) {
                        onColumnDrop(dragFrom, colIndex)
                      }
                      setDragFrom(null)
                      setDragOver(null)
                    }
                  : undefined
              }
              className={`border border-[var(--border)] ${
                editable && dragOver === colIndex
                  ? "bg-[var(--accent)]"
                  : "bg-[var(--muted)]"
              } p-0 text-left font-medium`}
            >
              <div className="flex items-stretch">
                {editable ? (
                  <span
                    draggable
                    onDragStart={() => setDragFrom(colIndex)}
                    onDragEnd={() => {
                      setDragFrom(null)
                      setDragOver(null)
                    }}
                    aria-label={`Reorder column ${col.label}`}
                    title="Drag to reorder"
                    className="flex cursor-grab items-center px-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  >
                    ⠿
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => toggleSort(col.id)}
                  className={`flex w-full items-center gap-1 px-2 py-1 hover:bg-[var(--accent)] ${
                    colType === "number" ? "justify-end" : ""
                  }`}
                >
                  {col.label}
                  {active ? (
                    <span aria-hidden>{sort.dir === "asc" ? "▲" : "▼"}</span>
                  ) : null}
                  {editable ? (
                    <Popover
                      open={typePopoverColId === col.id}
                      onOpenChange={(o) => setTypePopoverColId(o ? col.id : null)}
                    >
                      <PopoverTrigger asChild>
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={`Change type of ${col.label}`}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.stopPropagation()
                            }
                          }}
                          className="ml-1 cursor-pointer rounded bg-[var(--muted)] px-1 py-0.5 text-[10px] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                        >
                          {COLUMN_TYPE_GLYPHS[colType]}
                        </span>
                      </PopoverTrigger>
                      <PopoverContent className="w-32 p-2 text-xs">
                        <div className="space-y-1">
                          {COLUMN_TYPES.map((opt) => (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => {
                                onSetColumnType(col.id, opt)
                                setTypePopoverColId(null)
                              }}
                              className={`block w-full rounded px-2 py-1 text-left hover:bg-[var(--accent)] ${
                                colType === opt ? "bg-[var(--accent)] font-medium" : ""
                              }`}
                            >
                              {COLUMN_TYPE_LABELS[opt]}
                            </button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  ) : null}
                  {editable ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Remove column ${col.label}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemoveColumn(col.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          e.stopPropagation()
                          onRemoveColumn(col.id)
                        }
                      }}
                      className="ml-auto cursor-pointer text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    >
                      ×
                    </span>
                  ) : null}
                </button>
              </div>
            </th>
          )
        })}
        {editable ? (
          <th
            scope="col"
            aria-label="Add column"
            className="border border-[var(--border)] bg-[var(--muted)] p-0 text-left font-medium"
          >
            <button
              type="button"
              onClick={() => setAddColOpen(true)}
              disabled={data.columns.length >= 12}
              className="flex w-full items-center justify-center px-2 py-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
              title="Add column"
            >
              +
            </button>
          </th>
        ) : null}
      </tr>
      <Dialog
        open={addColOpen}
        onOpenChange={(open) => {
          setAddColOpen(open)
          if (!open) {
            setNewColLabel("")
            setNewColType("text")
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add column</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newColLabel}
            onChange={(e) => setNewColLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                submitAddColumn()
              }
            }}
            placeholder="Column label (e.g. Price)"
            maxLength={120}
          />
          <div className="flex items-center gap-3 py-1 text-xs">
            <span className="text-[var(--muted-foreground)]">Type</span>
            {COLUMN_TYPES.map((opt) => (
              <label key={opt} className="flex cursor-pointer items-center gap-1">
                <input
                  type="radio"
                  name="column-type"
                  value={opt}
                  checked={newColType === opt}
                  onChange={() => setNewColType(opt)}
                />
                {COLUMN_TYPE_LABELS[opt]}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAddColOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={submitAddColumn} disabled={!newColLabel.trim()}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
