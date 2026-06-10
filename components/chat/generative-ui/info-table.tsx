"use client"
import "client-only"

/**
 * InfoTable — the v1 generative-UI kind. Read-only structured table
 * the model emits via the `renderUI` tool when a key/value pair or a
 * columnar comparison reads better than prose.
 *
 * Two layouts share one component:
 *   - `columns` absent → key/value list. Each row's first cell is
 *     rendered as a label, second cell as a value.
 *   - `columns` present → multi-column grid. Headers come from the
 *     `columns` array; row cells are keyed by the column id.
 *
 * Renders defensively — the renderer's caller re-validates the props
 * against the shared Zod schema before invoking, but the component
 * still tolerates missing rows / cells without crashing.
 */

import { type InfoTableProps } from "@/shared/generative-ui/schemas"
import { cn } from "@/shared/utils"

export function InfoTable({ props }: { props: unknown; inert: boolean }) {
  // The registry validated `props` against `InfoTablePropsSchema`
  // before invoking; this cast is the post-validation handle.
  const p = props as InfoTableProps
  const rows = p.rows ?? []
  const columns = p.columns

  return (
    <figure
      className={cn(
        "my-3 overflow-hidden rounded-lg border border-[var(--border)]",
        "bg-[var(--card)] text-[var(--card-foreground)]",
      )}
      aria-label={p.title ? `Table: ${p.title}` : "Table"}
    >
      {p.title ? (
        <figcaption
          className={cn(
            "border-b border-[var(--border)] bg-[var(--muted)] px-3 py-1.5",
            "text-[11px] font-medium uppercase tracking-wide",
            "text-[var(--muted-foreground)]",
          )}
        >
          {p.title}
        </figcaption>
      ) : null}

      {rows.length === 0 ? (
        <div className="px-3 py-2 text-xs italic text-[var(--muted-foreground)]">
          (empty)
        </div>
      ) : columns && columns.length > 0 ? (
        <ColumnarTable columns={columns} rows={rows} />
      ) : (
        <KeyValueTable rows={rows} />
      )}
    </figure>
  )
}

function KeyValueTable({
  rows,
}: {
  rows: ReadonlyArray<Record<string, string>>
}) {
  return (
    <dl className="divide-y divide-[var(--border)] text-xs">
      {rows.map((row, i) => {
        // Take the first two cells as `key` / `value`. Schema doesn't
        // require those exact field names — empty rows render blank
        // to preserve the index ordering the model produced.
        const entries = Object.entries(row)
        const [labelCell, valueCell] = entries
        return (
          <div
            key={i}
            className={cn(
              "grid grid-cols-[max-content_1fr] gap-x-3 px-3 py-1.5",
            )}
          >
            <dt className="font-medium text-[var(--muted-foreground)]">
              {labelCell?.[1] ?? labelCell?.[0] ?? ""}
            </dt>
            <dd className="text-[var(--foreground)]">{valueCell?.[1] ?? ""}</dd>
          </div>
        )
      })}
    </dl>
  )
}

function ColumnarTable({
  columns,
  rows,
}: {
  columns: ReadonlyArray<{ id: string; label: string }>
  rows: ReadonlyArray<Record<string, string>>
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-[var(--muted)]/40">
          <tr>
            {columns.map((col) => (
              <th
                key={col.id}
                scope="col"
                className={cn(
                  "px-3 py-1.5 text-left font-medium",
                  "text-[var(--muted-foreground)]",
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => (
                <td key={col.id} className="px-3 py-1.5 align-top">
                  {row[col.id] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
