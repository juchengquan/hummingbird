"use client"
import "client-only"

/**
 * Shell for the citation-table artifact. Read-only by default; when an
 * `onChange` handler is supplied, columns sort on header click, cell
 * VALUES are editable in place, citations stay editable chips, columns
 * carry a text/number type, and rows + columns can be added / removed /
 * reordered. Sorting is view-state only (never calls `onChange`); every
 * mutation calls `onChange` with a pure-helper result from the data
 * layer. Self-contained from the embedded `sources`.
 *
 * Subcomponents:
 *  - CitationTableHeader — sort toggle, column type pill, drag-reorder,
 *    remove-column ×, add-column dialog.
 *  - CitationTableRow — per-cell editing, typed cell rendering (number
 *    right-align + tolerate-and-warn ⚠), citation chips/editor,
 *    remove-row ×.
 */

import { useState } from "react"

import { CitationTableHeader } from "@/components/panels/citation-table-header"
import { CitationTableRow } from "@/components/panels/citation-table-row"
import { Button } from "@/components/ui/button"
import type { ColumnType } from "@/shared/artifacts/column-type"
import { resolveColumnType } from "@/shared/artifacts/column-type"
import {
  type CitationTable,
  addColumn,
  addRow,
  moveColumn,
  removeColumn,
  setColumnType,
  sortRowOrder,
} from "@/shared/artifacts/citation-table"

export function CitationTableView({
  data,
  onChange,
}: {
  data: CitationTable
  onChange?: (next: CitationTable) => void
}) {
  const editable = !!onChange
  const [sort, setSort] = useState<{
    columnId: string
    dir: "asc" | "desc"
  } | null>(null)

  const order = sort
    ? sortRowOrder(
        data,
        sort.columnId,
        sort.dir,
        resolveColumnType(data.columns.find((c) => c.id === sort.columnId) ?? {}),
      )
    : data.rows.map((_, i) => i)

  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead>
          <CitationTableHeader
            data={data}
            sort={sort}
            onSortChange={setSort}
            editable={editable}
            onSetColumnType={(columnId: string, type: ColumnType) =>
              onChange?.(setColumnType(data, columnId, type))
            }
            onRemoveColumn={(columnId: string) =>
              onChange?.(removeColumn(data, columnId))
            }
            onAddColumn={(label: string, columnId: string, type: ColumnType) =>
              onChange?.(addColumn(data, label, columnId, type))
            }
            onColumnDrop={(from: number, to: number) =>
              onChange?.(moveColumn(data, from, to))
            }
          />
        </thead>
        <tbody>
          {order.map((rowIndex, displayIdx) => (
            <CitationTableRow
              key={`row-${rowIndex}`}
              data={data}
              rowIndex={rowIndex}
              displayIdx={displayIdx}
              editable={editable}
              onChange={onChange}
            />
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
    </div>
  )
}
