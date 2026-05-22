"use client"

/**
 * Text / JSON preview drawer. Slides in from the right (same Sheet
 * pattern as PdfViewerHost, DocxViewerHost). Two modes:
 *
 *  - `.json` → pretty-printed + rendered via MarkdownPreview inside a
 *    ```json fence so syntax highlighting + collapse cues "just work"
 *    (no extra library).
 *  - `.txt` (and everything else) → plain `<pre className="whitespace-pre-wrap">`
 *    surface that preserves the file's own line breaks.
 *
 * Content is decoded from the file's blob client-side. No server
 * round-trip beyond the blob fetch itself.
 */

import { Download, ExternalLink, Loader2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { PreviewHeader } from "@/components/preview/preview-header"
import { MarkdownPreview } from "@/components/markdown-preview"
import { useStore } from "@/client/hooks/use-store"
import { fetchFileBlob } from "@/client/files/fetch-blob"

import { useTextViewer } from "./types"

export function TextViewerHost() {
  const target = useTextViewer((s) => s.target)
  const close = useTextViewer((s) => s.close)
  if (!target) return null
  return <TextViewer fileId={target.fileId} onClose={close} />
}

interface TextViewerProps {
  fileId: string
  onClose: () => void
}

function TextViewer({ fileId, onClose }: TextViewerProps) {
  const file = useStore((s) => s.files.find((f) => f.id === fileId))
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Determine the rendering mode from the file's name/type. JSON gets
  // pretty-printed + highlighted; everything else (including `.csv`
  // if it lands here as a fallback, `.txt`, etc.) renders as pre-wrap.
  const mode: "json" | "text" = useMemo(() => {
    if (!file) return "text"
    const lower = file.name.toLowerCase()
    if (lower.endsWith(".json") || file.type === "application/json") return "json"
    return "text"
  }, [file])

  // Same race-prevention pattern the DOCX viewer uses: depend on
  // `fileId` only, read latest file from the store inside the effect
  // so store updates (extraction completion, storagePath sync) don't
  // cancel the in-flight load.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setText(null)

    void (async () => {
      try {
        const current = useStore
          .getState()
          .files.find((f) => f.id === fileId)
        const blob = await fetchFileBlob(
          current ?? { id: fileId, name: "file", size: 0, type: "text/plain", uploadedAt: new Date() }
        )
        if (cancelled) return
        if (!blob) {
          setError("Couldn't reach this file — it may be stored on another device.")
          setLoading(false)
          return
        }
        const raw = await blob.text()
        if (cancelled) return
        setText(raw)
        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to read file")
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fileId])

  // Pretty-print JSON when in JSON mode. If the file fails to parse
  // (truncated, malformed), fall back to the raw text — the user
  // should still be able to read what's there.
  const display = useMemo(() => {
    if (text === null) return null
    if (mode !== "json") return text
    try {
      const parsed = JSON.parse(text)
      return JSON.stringify(parsed, null, 2)
    } catch {
      return text
    }
  }, [text, mode])

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

  const typeLabel = useMemo(() => {
    if (!file) return undefined
    const m = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)
    return (m?.[1] ?? "TXT").toUpperCase()
  }, [file])

  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent
        side="right"
        className="w-full sm:w-[640px] sm:max-w-[80vw] p-0 gap-0 flex flex-col"
      >
        <SheetHeader className="shrink-0 pl-4 pr-12 py-2.5 border-b border-[var(--border)] space-y-0">
          <SheetTitle className="sr-only">
            {file?.name ?? "Text file"}
          </SheetTitle>
          <PreviewHeader
            title={file?.name ?? "File unavailable"}
            sizeBytes={file?.size}
            typeLabel={typeLabel}
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

        <div className="flex-1 min-h-0 overflow-y-auto bg-[var(--background)]">
          {error && (
            <div className="p-6 text-sm text-[var(--destructive)]">
              {error}
            </div>
          )}
          {!error && loading && (
            <div className="p-6 flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
              <Loader2 size={14} className="animate-spin" />
              Loading…
            </div>
          )}
          {!error && !loading && display !== null && (
            mode === "json" ? (
              // Reuse the existing markdown pipeline — its `json` fence
              // path already gives us syntax highlighting + the copy
              // button on the code block. Means we don't add a second
              // syntax library just for this surface.
              <div className="px-4 py-4">
                <MarkdownPreview content={"```json\n" + display + "\n```"} />
              </div>
            ) : (
              <pre className="px-4 py-4 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono text-[var(--foreground)]">
                {display}
              </pre>
            )
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
