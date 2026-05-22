"use client"

/**
 * DOCX preview drawer. Slides in from the right (same Sheet pattern as
 * <PdfViewerHost/>, <UrlPreviewHost/>, <ImageViewerHost/>) and renders
 * a Word document with reasonable fidelity using `docx-preview`.
 *
 * docx-preview is dynamic-imported on first open so its ~150 KB bundle
 * doesn't ship with the initial JS. Same lazy-load pattern pdfjs uses.
 *
 * Sandboxing: docx-preview renders into a plain div on the parent
 * origin (not an iframe). Word documents can contain embedded scripts
 * via OLE objects in theory, but `docx-preview` doesn't execute any of
 * that — it only walks the OOXML structure to emit HTML and CSS. So
 * unlike the live-artifact iframe, we don't need a separate origin.
 */

import { ChevronLeft, ChevronRight, Download, ExternalLink, RefreshCw, ZoomIn, ZoomOut } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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

import { useDocxViewer } from "./types"

export function DocxViewerHost() {
  const target = useDocxViewer((s) => s.target)
  const close = useDocxViewer((s) => s.close)
  if (!target) return null
  return <DocxViewer fileId={target.fileId} onClose={close} />
}

interface DocxViewerProps {
  fileId: string
  onClose: () => void
}

function DocxViewer({ fileId, onClose }: DocxViewerProps) {
  const file = useStore((s) => s.files.find((f) => f.id === fileId))
  // Track the container element via state + ref-callback rather than
  // useRef. This is what was broken before: a `useRef` reads as null on
  // the FIRST useEffect run because Radix Sheet portals its content,
  // and the effect's `if (!root) return` then bailed without ever
  // scheduling another attempt — so the user saw "Rendering document…"
  // forever, until they hit Refresh (which re-ran the effect with the
  // ref attached). Storing the element in state guarantees the render
  // effect runs *exactly when* the container is in the DOM.
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  // The scrollable wrapper around `container` — needed for page-nav
  // scroll tracking. Stored via ref-callback for the same reason as
  // the inner container.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Refresh by incrementing a key — same trick the PDF + live-artifact
  // surfaces use for "re-render with fresh state."
  const [refreshKey, setRefreshKey] = useState(0)
  // Page nav + zoom state. `pageEls` is populated after each successful
  // render by walking the rendered container for top-level page
  // sections (docx-preview emits one `<section>` per hard page break).
  // `numPages` is just `pageEls.length` and may be 0 for documents
  // without explicit pagination (in which case the page controls hide).
  const pageElsRef = useRef<HTMLElement[]>([])
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  // Zoom is applied as `transform: scale()` on `container`, with the
  // wrapper holding `overflow: auto` so scrollbars track the scaled
  // extents. `transform-origin: top left` keeps the doc anchored under
  // the cursor when zooming.
  const MIN_DOCX_SCALE = 0.5
  const MAX_DOCX_SCALE = 2.5
  const DOCX_SCALE_STEP = 0.25
  const [scale, setScale] = useState(1)
  const clampScale = (n: number) =>
    Math.max(MIN_DOCX_SCALE, Math.min(MAX_DOCX_SCALE, n))

  // Render effect. Deps:
  //  - `container` — fires once the ref-callback attaches the element.
  //  - `fileId` — switches file via the store.
  //  - `refreshKey` — manual Refresh action.
  //
  // `file` is NOT a dep — the row's reference changes whenever the
  // store updates (extraction completion, storagePath sync), and an
  // in-flight `renderAsync` getting cancelled mid-frame is what blew
  // up the first attempt at this fix. We look up the current file from
  // the store *inside* the effect instead.
  useEffect(() => {
    if (!container) return
    let cancelled = false
    // Clear any previous render synchronously — docx-preview appends
    // into the container, so a stale render would stack visually.
    container.innerHTML = ""
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        const current = useStore
          .getState()
          .files.find((f) => f.id === fileId)
        const blob = await fetchFileBlob(
          current ?? {
            id: fileId,
            name: "file",
            size: 0,
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            uploadedAt: new Date(),
          }
        )
        if (cancelled) return
        if (!blob) {
          setError("Couldn't reach this file — it may be stored on another device.")
          setLoading(false)
          return
        }
        const { renderAsync } = await import("docx-preview")
        if (cancelled) return
        await renderAsync(blob, container, undefined, {
          // Match the surrounding chat surface — no extra wrapper chrome.
          inWrapper: false,
          ignoreLastRenderedPageBreak: true,
          // Render at a reasonable on-screen scale; the user can zoom
          // the whole drawer via browser zoom if needed.
          className: "docx-rendered",
        })
        if (!cancelled) {
          // docx-preview emits one top-level `<section>` per page break
          // (and a `.docx` div for the page surface inside each). We
          // count those as "pages" for the page-nav UI. Docs without
          // explicit pagination produce zero sections — in that case
          // the page controls hide.
          const sections = Array.from(
            container.querySelectorAll<HTMLElement>(":scope > section, :scope > .docx")
          )
          pageElsRef.current = sections
          setNumPages(sections.length)
          setCurrentPage(1)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render document")
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [container, fileId, refreshKey])

  // Track current page on scroll. Mirrors the PDF viewer's pattern: a
  // "best so far" sweep through page elements, finding the topmost
  // section whose top is at or just above a measurement line 40 px
  // below the scroll container's top.
  useEffect(() => {
    if (!scrollEl || numPages === 0) return
    const handler = () => {
      const containerRect = scrollEl.getBoundingClientRect()
      const targetY = containerRect.top + 40
      let best = 1
      pageElsRef.current.forEach((el, i) => {
        const rect = el.getBoundingClientRect()
        if (rect.top <= targetY && rect.bottom > targetY) best = i + 1
      })
      setCurrentPage(best)
    }
    handler()
    scrollEl.addEventListener("scroll", handler, { passive: true })
    return () => scrollEl.removeEventListener("scroll", handler)
  }, [scrollEl, numPages])

  const goToPage = (p: number) => {
    const target = Math.max(1, Math.min(numPages, p))
    pageElsRef.current[target - 1]?.scrollIntoView({ behavior: "smooth", block: "start" })
    setCurrentPage(target)
  }

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
        // Revoke after a short delay so the new tab has time to load.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      } catch {
        toast.error("Open failed")
      }
    })()
  }

  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent
        side="right"
        className="w-full sm:w-[640px] sm:max-w-[80vw] p-0 gap-0 flex flex-col"
      >
        <SheetHeader className="shrink-0 pl-4 pr-12 py-2.5 border-b border-[var(--border)] space-y-0">
          {/* Hidden a11y title — PreviewHeader owns the visible title. */}
          <SheetTitle className="sr-only">
            {file?.name ?? "Document"}
          </SheetTitle>
          <PreviewHeader
            title={file?.name ?? "Document unavailable"}
            sizeBytes={file?.size}
            typeLabel="DOCX"
            updatedAt={file?.uploadedAt}
            controls={
              file && (
                <>
                  {/* Page nav — only when the document actually paginated
                      (most short DOCX files emit a single rendered
                      section and we hide the controls entirely). */}
                  {numPages > 0 && (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => goToPage(currentPage - 1)}
                        disabled={currentPage <= 1}
                        className="h-7 w-7 text-[var(--muted-foreground)]"
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
                        className="h-7 w-7 text-[var(--muted-foreground)]"
                        aria-label="Next page"
                      >
                        <ChevronRight size={14} />
                      </Button>
                      <span className="mx-1 h-4 w-px bg-[var(--border)]" />
                    </div>
                  )}
                  {/* Zoom controls — always available, applied as a CSS
                      transform on the rendered container. */}
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setScale((s) => clampScale(s - DOCX_SCALE_STEP))}
                      disabled={scale <= MIN_DOCX_SCALE}
                      className="h-7 w-7 text-[var(--muted-foreground)]"
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
                      onClick={() => setScale((s) => clampScale(s + DOCX_SCALE_STEP))}
                      disabled={scale >= MAX_DOCX_SCALE}
                      className="h-7 w-7 text-[var(--muted-foreground)]"
                      aria-label="Zoom in"
                    >
                      <ZoomIn size={14} />
                    </Button>
                  </div>
                </>
              )
            }
            actions={
              file
                ? [
                    {
                      // Refresh sits at the 3rd "group" position from
                      // the left of the right-aligned cluster: after
                      // [Pages] and [Zoom], before Download / Open.
                      icon: RefreshCw,
                      label: "Re-render",
                      onClick: () => setRefreshKey((k) => k + 1),
                    },
                    {
                      icon: Download,
                      label: "Download",
                      onClick: handleDownload,
                    },
                    {
                      icon: ExternalLink,
                      label: "Open in new tab",
                      onClick: handleOpen,
                    },
                  ]
                : []
            }
          />
        </SheetHeader>

        {/* Scrollable rendered surface. White background mirrors a
            "page" feel; the docx-preview-rendered HTML carries its own
            inline styles, so we just need a clean canvas.
            `overflow: auto` (not just `overflow-y`) so horizontal scroll
            kicks in when the user zooms past the container width. */}
        <div ref={setScrollEl} className="flex-1 min-h-0 overflow-auto bg-white">
          {error && (
            <div className="p-6 text-sm text-[var(--destructive)]">
              {error}
            </div>
          )}
          {!error && loading && (
            <div className="p-6 text-sm text-[var(--muted-foreground)]">
              Rendering document…
            </div>
          )}
          <div
            ref={setContainer}
            className={cn(
              "docx-viewer-root px-6 py-6 text-sm text-black origin-top-left transition-transform",
              // Hide the container until docx-preview finishes the
              // initial render — its intermediate DOM state can flash
              // partially-styled content.
              loading && "invisible"
            )}
            // Zoom via CSS transform. Origin top-left so the document
            // anchors to the scroll container's top-left when scaled.
            style={{ transform: `scale(${scale})` }}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
