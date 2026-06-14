"use client"
import "client-only"

/**
 * One data row (<tr>) of a citation-table artifact. Owns its own
 * per-cell edit state (row-local `editing`/`draft`, keyed by columnId
 * since the row already knows its rowIndex), typed cell rendering
 * (number columns right-align; tolerate-and-warn ⚠ glyph on cells that
 * fail `validateCell`), citation chips/editor, and the remove-row ×.
 * Cell-value and citation mutations are delegated to the data-layer
 * mutators via `onChange`, exactly as the original inline body did.
 * The private `CellContent` + `CitationChips` helpers moved here
 * unchanged. Pure structural extraction from CitationTableView — zero
 * behavior change.
 */

import { useState } from "react"

import { CitationCellEditor } from "@/components/panels/citation-cell-editor"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { resolveColumnType, validateCell } from "@/shared/artifacts/column-type"
import {
  type Citation,
  type CitationTable,
  type CitationTableCell,
  addCitation,
  removeCitation,
  removeRow,
  setCellValue,
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

export function CitationTableRow({
  data,
  rowIndex,
  displayIdx,
  editable,
  onChange,
}: {
  data: CitationTable
  rowIndex: number
  displayIdx: number
  editable: boolean
  onChange?: (next: CitationTable) => void
}) {
  const [editing, setEditing] = useState<{ columnId: string } | null>(null)
  const [draft, setDraft] = useState("")

  const startEdit = (columnId: string, current: string) => {
    if (!editable) return
    setDraft(current)
    setEditing({ columnId })
  }
  const commit = () => {
    if (editing && onChange) {
      onChange(setCellValue(data, rowIndex, editing.columnId, draft))
    }
    setEditing(null)
  }

  return (
    <tr>
      {data.columns.map((col) => {
        const cell = data.rows[rowIndex]?.[col.id]
        const isEditing = editing?.columnId === col.id
        const cellType = resolveColumnType(col)
        const cellWarning = editable ? validateCell(cell, cellType) : null
        const cellInner = (
          <CellContent
            data={data}
            cell={cell}
            editable={editable}
            onStartEdit={() => startEdit(col.id, cell?.value ?? "")}
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
  )
}
