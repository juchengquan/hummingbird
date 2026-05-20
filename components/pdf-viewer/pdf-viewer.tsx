"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut, AlertCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { fetchFileBlob } from "@/client/files/fetch-blob"
import { useStore } from "@/client/hooks/use-store"
import { cn } from "@/shared/utils"

import { usePdfViewer } from "./types"

// Lazy-loaded so pdfjs (~2 MB) only enters the bundle when the viewer
// actually opens. Held in module scope after first load to avoid the
// re-import cost on subsequent opens.
//
// Uses the **legacy** build which bundles the worker inline. The modern
// `pdfjs-dist/build/pdf.mjs` requires a separately-served worker file
// and tripped on `WeakMap.getOrInsertComputed` (a 2024 TC39 proposal
// not yet in every browser) when loaded via `import.meta.url` in
// Next.js. The legacy bundle is a few hundred KB larger but ships
// without those polyfill assumptions.
let pdfjsModule: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | null = null
async function loadPdfjs(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  if (pdfjsModule) return pdfjsModule
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs")
  if (typeof window !== "undefined" && !mod.GlobalWorkerOptions.workerSrc) {
    mod.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString()
  }
  pdfjsModule = mod
  return mod
}

const MIN_SCALE = 0.5
const MAX_SCALE = 3
const SCALE_STEP = 0.2

export function PdfViewerHost() {
  const target = usePdfViewer((s) => s.target)
  const close = usePdfViewer((s) => s.close)
  if (!target) return null
  return <PdfViewer fileId={target.fileId} initialPage={target.page} onClose={close} />
}

interface PdfViewerProps {
  fileId: string
  initialPage?: number
  onClose: () => void
}

function PdfViewer({ fileId, initialPage, onClose }: PdfViewerProps) {
  const files = useStore((s) => s.files)
  const file = files.find((f) => f.id === fileId)
  const [doc, setDoc] = useState<import("pdfjs-dist").PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(initialPage ?? 1)
  const [scale, setScale] = useState(1.25)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement | null>>(new Map())

  // Load the PDF when fileId changes. Runs in a single effect (no React
  // strict-mode double-mount races because the cleanup nulls the ref).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setDoc(null)
    setNumPages(0)

    void (async () => {
      try {
        const blob = await fetchFileBlob(file ?? { id: fileId, name: "file", size: 0, type: "application/pdf", uploadedAt: new Date() })
        if (!blob) {
          if (!cancelled) setError("Couldn't reach this file — it may be stored on another device.")
          return
        }
        const pdfjs = await loadPdfjs()
        const buffer = await blob.arrayBuffer()
        const task = pdfjs.getDocument({ data: buffer })
        const loaded = await task.promise
        if (cancelled) {
          await loaded.destroy()
          return
        }
        setDoc(loaded)
        setNumPages(loaded.numPages)
        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load PDF")
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [fileId, file])

  // Scroll to the target page after document loads.
  useEffect(() => {
    if (!doc || loading) return
    const page = initialPage ?? 1
    const node = pageRefs.current.get(page)
    if (node) {
      node.scrollIntoView({ behavior: "instant", block: "start" })
      setCurrentPage(page)
    }
  }, [doc, loading, initialPage])

  // Update currentPage as the user scrolls. Direct scroll math rather
  // than IntersectionObserver — the observer fires entries in DOM order
  // and the last "currently visible" page wins, which sets the counter
  // to the bottom page rather than the one actually in view.
  useEffect(() => {
    const root = scrollRef.current
    if (!root || numPages === 0) return
    const handler = () => {
      const rootRect = root.getBoundingClientRect()
      const targetY = rootRect.top + 40 // measure at 40px below the panel top
      let best = 1
      pageRefs.current.forEach((node, page) => {
        if (!node) return
        const rect = node.getBoundingClientRect()
        if (rect.top <= targetY && rect.bottom > targetY) best = page
      })
      setCurrentPage(best)
    }
    handler() // initial reading
    root.addEventListener("scroll", handler, { passive: true })
    return () => root.removeEventListener("scroll", handler)
  }, [numPages])

  const goToPage = (p: number) => {
    const target = Math.max(1, Math.min(numPages, p))
    pageRefs.current.get(target)?.scrollIntoView({ behavior: "smooth", block: "start" })
    setCurrentPage(target)
  }

  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent
        side="right"
        className="w-full sm:w-[640px] sm:max-w-[80vw] p-0 gap-0 flex flex-col"
      >
        <SheetHeader className="shrink-0 pl-4 pr-12 py-2.5 border-b border-[var(--border)] flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle className="text-sm font-medium truncate flex-1 min-w-0" title={file?.name ?? "PDF"}>
            {file?.name ?? "PDF"}
          </SheetTitle>
          {numPages > 0 && (
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1}
                className="h-7 w-7"
                aria-label="Previous page"
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="text-xs tabular-nums text-[var(--muted-foreground)]">
                {currentPage} / {numPages}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= numPages}
                className="h-7 w-7"
                aria-label="Next page"
              >
                <ChevronRight size={14} />
              </Button>
              <span className="mx-1 h-4 w-px bg-[var(--border)]" />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setScale((s) => Math.max(MIN_SCALE, s - SCALE_STEP))}
                disabled={scale <= MIN_SCALE}
                className="h-7 w-7"
                aria-label="Zoom out"
              >
                <ZoomOut size={14} />
              </Button>
              <button
                type="button"
                onClick={() => setScale(1)}
                disabled={scale === 1}
                aria-label="Reset zoom"
                title="Reset zoom"
                className="text-[10px] tabular-nums text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:cursor-default disabled:hover:text-[var(--muted-foreground)] w-9 h-7 rounded text-center transition-colors"
              >
                {Math.round(scale * 100)}%
              </button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setScale((s) => Math.min(MAX_SCALE, s + SCALE_STEP))}
                disabled={scale >= MAX_SCALE}
                className="h-7 w-7"
                aria-label="Zoom in"
              >
                <ZoomIn size={14} />
              </Button>
            </div>
          )}
        </SheetHeader>

        <div ref={scrollRef} className="flex-1 overflow-auto bg-[var(--muted)]/30">
          {loading && (
            <div className="flex items-center justify-center h-32 text-sm text-[var(--muted-foreground)] gap-2">
              <Loader2 size={14} className="animate-spin" />
              Loading…
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 m-4 p-3 rounded border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 text-sm text-[var(--destructive)]">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <p>{error}</p>
            </div>
          )}
          {doc && (
            // `min-w-full w-max`: container grows to the widest child
            // (`w-max` = `width: max-content`) but is also at least as wide
            // as the viewport (`min-w-full`). This keeps pages centered when
            // they fit AND lets the scroll container reach the left edge
            // when zoomed past viewport width.
            <div className="min-w-full w-max flex flex-col items-center gap-3 py-3 px-3">
              {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
                <PdfPage
                  key={p}
                  doc={doc}
                  pageNumber={p}
                  scale={scale}
                  pageRefs={pageRefs}
                />
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

interface PdfPageProps {
  doc: import("pdfjs-dist").PDFDocumentProxy
  pageNumber: number
  scale: number
  pageRefs: React.MutableRefObject<Map<number, HTMLDivElement | null>>
}

function PdfPage({ doc, pageNumber, scale, pageRefs }: PdfPageProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    const refs = pageRefs.current
    if (el) refs.set(pageNumber, el)
    return () => {
      refs.delete(pageNumber)
    }
  }, [pageNumber, pageRefs])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext("2d")
      if (!ctx) return
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      setSize({ w: viewport.width, h: viewport.height })
      const renderOpts: Parameters<typeof page.render>[0] = {
        canvasContext: ctx,
        viewport,
        canvas,
      }
      if (dpr !== 1) renderOpts.transform = [dpr, 0, 0, dpr, 0, 0]
      const task = page.render(renderOpts)
      try {
        await task.promise
      } catch {
        /* render cancelled — page changed, ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc, pageNumber, scale])

  return (
    <div
      ref={containerRef}
      data-page={pageNumber}
      className={cn(
        "bg-white shadow-md rounded-sm overflow-hidden",
        // Reserve space using the last-known viewport size so the page
        // doesn't collapse while the canvas is re-rendering on zoom.
        "transition-[width,height]"
      )}
      style={size ? { width: size.w, height: size.h } : undefined}
    >
      <canvas
        ref={canvasRef}
        style={size ? { width: size.w, height: size.h } : undefined}
      />
    </div>
  )
}
