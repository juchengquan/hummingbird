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

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  type CitationTable,
  type CitationTableCell,
  setCellValue,
  sortRowOrder,
  sourceIndex,
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
}: {
  data: CitationTable
  cell?: CitationTableCell
  editable: boolean
  onStartEdit: () => void
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
      {cell ? <CitationChips data={data} cell={cell} /> : null}
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

  const order = sort
    ? sortRowOrder(data, sort.columnId, sort.dir)
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

  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {data.columns.map((col) => {
              const active = sort?.columnId === col.id
              return (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={
                    active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
                  }
                  className="border border-[var(--border)] bg-[var(--muted)] p-0 text-left font-medium"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.id)}
                    className="flex w-full items-center gap-1 px-2 py-1 hover:bg-[var(--accent)]"
                  >
                    {col.label}
                    {active ? <span aria-hidden>{sort.dir === "asc" ? "▲" : "▼"}</span> : null}
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {order.map((rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {data.columns.map((col) => {
                const cell = data.rows[rowIndex]?.[col.id]
                const isEditing =
                  editing?.rowIndex === rowIndex && editing?.columnId === col.id
                return (
                  <td
                    key={col.id}
                    className="border border-[var(--border)] px-2 py-1 align-top"
                  >
                    {isEditing ? (
                      <input
                        autoFocus
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
                      <CellContent
                        data={data}
                        cell={cell}
                        editable={editable}
                        onStartEdit={() => startEdit(rowIndex, col.id, cell?.value ?? "")}
                      />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
