"use client"

/**
 * CSV preview drawer. Parses the raw file with papaparse (dynamic
 * import so it's only pulled in when the viewer first opens) and
 * renders the result as an HTML table with a sticky header.
 *
 * Row cap: papaparse can stream gigabytes but the browser can't
 * comfortably DOM-mount millions of `<tr>`. We cap rendered rows at
 * CSV_ROW_CAP and surface a "showing N of M" footer when the source
 * has more. The Download action still gives the user the full file.
 */

import { Download, ExternalLink, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { PreviewHeader } from "@/components/preview/preview-header"
import { useStore } from "@/client/hooks/use-store"
import { fetchFileBlob } from "@/client/files/fetch-blob"
import { cn } from "@/shared/utils"

import { useCsvViewer } from "./types"

const CSV_ROW_CAP = 1000

export function CsvViewerHost() {
  const target = useCsvViewer((s) => s.target)
  const close = useCsvViewer((s) => s.close)
  if (!target) return null
  return <CsvViewer fileId={target.fileId} onClose={close} />
}

interface CsvViewerProps {
  fileId: string
  onClose: () => void
}

interface ParsedCsv {
  /** First non-empty row treated as header. May be empty strings; the
   *  table renders them as `Column N` to keep the visual rhythm. */
  header: string[]
  /** Subsequent rows. Cap-respected. */
  rows: string[][]
  /** Total parsed rows from the source (before the cap). */
  total: number
}

function CsvViewer({ fileId, onClose }: CsvViewerProps) {
  const file = useStore((s) => s.files.find((f) => f.id === fileId))
  const [parsed, setParsed] = useState<ParsedCsv | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setParsed(null)
    void (async () => {
      try {
        const current = useStore
          .getState()
          .files.find((f) => f.id === fileId)
        const blob = await fetchFileBlob(
          current ?? { id: fileId, name: "file", size: 0, type: "text/csv", uploadedAt: new Date() }
        )
        if (cancelled) return
        if (!blob) {
          setError("Couldn't reach this file — it may be stored on another device.")
          setLoading(false)
          return
        }
        const raw = await blob.text()
        const { default: Papa } = await import("papaparse")
        if (cancelled) return
        const result = Papa.parse<string[]>(raw, {
          skipEmptyLines: true,
        })
        const all = result.data as string[][]
        const header = all[0] ?? []
        const rows = all.slice(1, 1 + CSV_ROW_CAP)
        setParsed({ header, rows, total: Math.max(0, all.length - 1) })
        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to parse CSV")
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fileId])

  const handleDownload = () => {
    if (!file) return
    void (async () => {
      try {
        const blob = await fetchFileBlob(file)
        if (!blob) {
          toast.error("Couldn't reach this file to download")
          return
        }
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = file.name
        a.click()
        URL.revokeObjectURL(url)
      } catch {
        toast.error("Download failed")
      }
    })()
  }
  const handleOpen = () => {
    if (!file) return
    void (async () => {
      try {
        const blob = await fetchFileBlob(file)
        if (!blob) {
          toast.error("Couldn't reach this file")
          return
        }
        const url = URL.createObjectURL(blob)
        window.open(url, "_blank", "noopener,noreferrer")
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      } catch {
        toast.error("Open failed")
      }
    })()
  }

  const truncated =
    parsed !== null && parsed.total > parsed.rows.length

  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent
        side="right"
        className="w-full sm:w-[640px] sm:max-w-[80vw] p-0 gap-0 flex flex-col"
      >
        <SheetHeader className="shrink-0 pl-4 pr-12 py-2.5 border-b border-[var(--border)] space-y-0">
          <SheetTitle className="sr-only">
            {file?.name ?? "CSV"}
          </SheetTitle>
          <PreviewHeader
            title={file?.name ?? "CSV unavailable"}
            sizeBytes={file?.size}
            typeLabel="CSV"
            updatedAt={file?.uploadedAt}
            actions={
              file
                ? [
                    { icon: Download, label: "Download", onClick: handleDownload },
                    { icon: ExternalLink, label: "Open in new tab", onClick: handleOpen },
                  ]
                : []
            }
          />
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-auto bg-[var(--background)]">
          {error && (
            <div className="p-6 text-sm text-[var(--destructive)]">{error}</div>
          )}
          {!error && loading && (
            <div className="p-6 flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
              <Loader2 size={14} className="animate-spin" />
              Parsing…
            </div>
          )}
          {!error && !loading && parsed && (
            <>
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 z-10 bg-[var(--muted)] text-[var(--foreground)]">
                  <tr>
                    {parsed.header.map((h, idx) => (
                      <th
                        key={idx}
                        className={cn(
                          "text-left font-medium px-3 py-1.5 border-b border-[var(--border)] whitespace-nowrap",
                          // Numbered placeholder when the header cell
                          // was blank in the source — keeps the column
                          // recognisable.
                          !h && "italic text-[var(--muted-foreground)]"
                        )}
                      >
                        {h || `Column ${idx + 1}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className={cn(
                        "border-b border-[var(--border)]/60",
                        rIdx % 2 === 1 && "bg-[var(--muted)]/30"
                      )}
                    >
                      {parsed.header.map((_, cIdx) => (
                        <td
                          key={cIdx}
                          className="px-3 py-1 align-top whitespace-pre-wrap break-words"
                        >
                          {row[cIdx] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {truncated && (
                <div className="sticky bottom-0 bg-[var(--background)] border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted-foreground)]">
                  Showing first {parsed.rows.length.toLocaleString()} of {parsed.total.toLocaleString()} rows. Download the file for the full dataset.
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
