"use client"
import "client-only"

/**
 * Read-only renderer for a citation-table artifact (Slice 1 of the
 * Elicit-style extraction tables). Draws a grid; each cell value is
 * followed by `[N]` chips (one per citation) that open a Popover with
 * the source title/url + the supporting quote. Self-contained from the
 * artifact's embedded `sources`. Editing / sorting / generation are
 * later slices.
 */

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  type CitationTable,
  type CitationTableCell,
  sourceIndex,
} from "@/shared/artifacts/citation-table"

function Cell({ data, cell }: { data: CitationTable; cell?: CitationTableCell }) {
  if (!cell) {
    return <span className="text-[var(--muted-foreground)]">—</span>
  }
  return (
    <span>
      {cell.value}
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
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
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
    </span>
  )
}

export function CitationTableView({ data }: { data: CitationTable }) {
  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {data.columns.map((col) => (
              <th
                key={col.id}
                scope="col"
                className="border border-[var(--border)] bg-[var(--muted)] px-2 py-1 text-left font-medium"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={`row-${i}`}>
              {data.columns.map((col) => (
                <td
                  key={col.id}
                  className="border border-[var(--border)] px-2 py-1 align-top"
                >
                  <Cell data={data} cell={row[col.id]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
