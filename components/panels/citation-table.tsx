"use client"
import "client-only"

/**
 * Renderer for a citation-table artifact. Read-only by default; when an
 * `onChange` handler is supplied, columns sort on header click and cell
 * VALUES are editable in place (citations stay read-only chips). Sorting
 * is view-state only (never calls `onChange`); an edit calls
 * `onChange(setCellValue(...))`. Self-contained from the embedded
 * `sources`. (Slices 1–3 of the Elicit-style extraction tables.)
 */

import { useState } from "react"

import { CitationCellEditor } from "@/components/panels/citation-cell-editor"
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
import { resolveColumnType, validateCell } from "@/shared/artifacts/column-type"
import {
  type Citation,
  type CitationTable,
  type CitationTableCell,
  addCitation,
  addColumn,
  addRow,
  moveColumn,
  removeCitation,
  removeColumn,
  removeRow,
  setCellValue,
  sortRowOrder,
  sourceIndex,
  updateCitation,
} from "@/shared/artifacts/citation-table"

function CitationChips({ data, cell }: { data: CitationTable; cell: CitationTableCell }) {
  return (
    <>
      {cell.citations.map((c, i) => {
        const idx = sourceIndex(data, c.sourceId)
        if (idx === null) return null
        const source = data.sources[idx - 1]
        return (
          <Popover key={`${c.sourceId}-${i}`}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="ml-0.5 align-super text-[10px] text-[var(--primary)] hover:underline"
                aria-label={`Source ${idx}: ${source?.title}`}
              >
                [{idx}]
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80 text-xs">
              <div className="font-medium">
                {source?.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer" className="hover:underline">
                    {source.title}
                  </a>
                ) : (
                  source?.title
                )}
              </div>
              <blockquote className="mt-1 border-l-2 border-[var(--border)] pl-2 text-[var(--muted-foreground)]">
                {c.quote}
              </blockquote>
            </PopoverContent>
          </Popover>
        )
      })}
    </>
  )
}

function CellContent({
  data,
  cell,
  editable,
  onStartEdit,
  onAddCitation,
  onUpdateCitation,
  onRemoveCitation,
}: {
  data: CitationTable
  cell?: CitationTableCell
  editable: boolean
  onStartEdit: () => void
  onAddCitation: (citation: Citation) => void
  onUpdateCitation: (citIndex: number, patch: Partial<Citation>) => void
  onRemoveCitation: (citIndex: number) => void
}) {
  const value = cell?.value ?? ""
  const valueEl = editable ? (
    <button type="button" onClick={onStartEdit} className="text-left hover:underline">
      {value || <span className="text-[var(--muted-foreground)]">—</span>}
    </button>
  ) : value ? (
    <span>{value}</span>
  ) : (
    <span className="text-[var(--muted-foreground)]">—</span>
  )
  return (
    <span>
      {valueEl}
      {editable ? (
        <CitationCellEditor
          sources={data.sources}
          citations={cell?.citations ?? []}
          onAdd={onAddCitation}
          onUpdate={onUpdateCitation}
          onRemove={onRemoveCitation}
        />
      ) : cell ? (
        <CitationChips data={data} cell={cell} />
      ) : null}
    </span>
  )
}

export function CitationTableView({
  data,
  onChange,
}: {
  data: CitationTable
  onChange?: (next: CitationTable) => void
}) {
  const editable = !!onChange
  const [sort, setSort] = useState<{ columnId: string; dir: "asc" | "desc" } | null>(null)
  const [editing, setEditing] = useState<{ rowIndex: number; columnId: string } | null>(null)
  const [draft, setDraft] = useState("")
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [typePopoverColId, setTypePopoverColId] = useState<string | null>(null)

  const order = sort
    ? sortRowOrder(
        data,
        sort.columnId,
        sort.dir,
        resolveColumnType(data.columns.find((c) => c.id === sort.columnId) ?? {}),
      )
    : data.rows.map((_, i) => i)

  const toggleSort = (columnId: string) =>
    setSort((s) =>
      s && s.columnId === columnId
        ? { columnId, dir: s.dir === "asc" ? "desc" : "asc" }
        : { columnId, dir: "asc" },
    )

  const startEdit = (rowIndex: number, columnId: string, current: string) => {
    if (!editable) return
    setDraft(current)
    setEditing({ rowIndex, columnId })
  }
  const commit = () => {
    if (editing && onChange) {
      onChange(setCellValue(data, editing.rowIndex, editing.columnId, draft))
    }
    setEditing(null)
  }

  const [addColOpen, setAddColOpen] = useState(false)
  const [newColLabel, setNewColLabel] = useState("")
  const [newColType, setNewColType] = useState<ColumnType>("text")

  const slugify = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)

  const dedupeColumnId = (base: string): string => {
    if (!data.columns.some((c) => c.id === base)) return base
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`
      if (!data.columns.some((c) => c.id === candidate)) return candidate
    }
    return `${base}-${Date.now()}`
  }

  const submitAddColumn = () => {
    const label = newColLabel.trim().slice(0, 120)
    if (!label || !onChange) return
    const base = slugify(label) || "column"
    const columnId = dedupeColumnId(base)
    onChange(addColumn(data, label, columnId, newColType))
    setNewColLabel("")
    setNewColType("text")
    setAddColOpen(false)
  }

  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead>
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
                          if (dragFrom !== null && onChange) {
                            onChange(moveColumn(data, dragFrom, colIndex))
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
                              {colType === "number" ? "#" : "Aa"}
                            </span>
                          </PopoverTrigger>
                          <PopoverContent className="w-32 p-2 text-xs">
                            <div className="space-y-1">
                              {(["text", "number"] as const).map((opt) => (
                                <button
                                  key={opt}
                                  type="button"
                                  onClick={() => {
                                    if (onChange) {
                                      onChange({
                                        ...data,
                                        columns: data.columns.map((c) =>
                                          c.id === col.id ? { ...c, type: opt } : c,
                                        ),
                                      })
                                    }
                                    setTypePopoverColId(null)
                                  }}
                                  className={`block w-full rounded px-2 py-1 text-left hover:bg-[var(--accent)] ${
                                    colType === opt ? "bg-[var(--accent)] font-medium" : ""
                                  }`}
                                >
                                  {opt === "text" ? "Text" : "Number"}
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
                            if (onChange) onChange(removeColumn(data, col.id))
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              e.stopPropagation()
                              if (onChange) onChange(removeColumn(data, col.id))
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
        </thead>
        <tbody>
          {order.map((rowIndex, displayIdx) => (
            <tr key={`row-${rowIndex}`}>
              {data.columns.map((col) => {
                const cell = data.rows[rowIndex]?.[col.id]
                const isEditing =
                  editing?.rowIndex === rowIndex && editing?.columnId === col.id
                const cellType = resolveColumnType(col)
                const cellWarning = editable ? validateCell(cell, cellType) : null
                const cellInner = (
                  <CellContent
                    data={data}
                    cell={cell}
                    editable={editable}
                    onStartEdit={() => startEdit(rowIndex, col.id, cell?.value ?? "")}
                    onAddCitation={(c) => onChange?.(addCitation(data, rowIndex, col.id, c))}
                    onUpdateCitation={(i, patch) =>
                      onChange?.(updateCitation(data, rowIndex, col.id, i, patch))
                    }
                    onRemoveCitation={(i) =>
                      onChange?.(removeCitation(data, rowIndex, col.id, i))
                    }
                  />
                )
                if (!editable) {
                  // Read-only path — unchanged from before typed columns.
                  return (
                    <td
                      key={col.id}
                      className="border border-[var(--border)] px-2 py-1 align-top"
                    >
                      {cellInner}
                    </td>
                  )
                }
                return (
                  <td
                    key={col.id}
                    className={`border border-[var(--border)] px-2 py-1 align-top ${
                      cellType === "number" ? "text-right" : ""
                    }`}
                  >
                    <span className="inline-flex items-start gap-0.5">
                      <span className="flex-1">
                        {isEditing ? (
                          <input
                            autoFocus
                            type={cellType === "number" ? "number" : "text"}
                            inputMode={cellType === "number" ? "decimal" : undefined}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault()
                                commit()
                              } else if (e.key === "Escape") {
                                e.preventDefault()
                                setEditing(null)
                              }
                            }}
                            aria-label="Edit cell value"
                            className="w-full bg-[var(--background)] px-1 text-xs outline-none ring-1 ring-[var(--ring)]"
                          />
                        ) : (
                          cellInner
                        )}
                      </span>
                      {cellWarning ? (
                        <span
                          title={cellWarning}
                          aria-label={cellWarning}
                          className="select-none text-[var(--destructive)]"
                        >
                          ⚠
                        </span>
                      ) : null}
                    </span>
                  </td>
                )
              })}
              {editable ? (
                <td className="border border-[var(--border)] p-0 text-center align-top">
                  <button
                    type="button"
                    aria-label={`Remove row ${displayIdx + 1}`}
                    title="Remove row"
                    onClick={() => {
                      setEditing(null)
                      if (onChange) onChange(removeRow(data, rowIndex))
                    }}
                    className="px-2 py-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                  >
                    ×
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        {editable ? (
          <tfoot>
            <tr>
              <td
                colSpan={data.columns.length + 1}
                className="border border-[var(--border)] px-2 py-1 text-center"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange && onChange(addRow(data))}
                  disabled={data.rows.length >= 200}
                  className="h-6 text-xs"
                >
                  + Add row
                </Button>
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>
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
            {(["text", "number"] as const).map((opt) => (
              <label key={opt} className="flex cursor-pointer items-center gap-1">
                <input
                  type="radio"
                  name="column-type"
                  value={opt}
                  checked={newColType === opt}
                  onChange={() => setNewColType(opt)}
                />
                {opt === "text" ? "Text" : "Number"}
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
    </div>
  )
}
