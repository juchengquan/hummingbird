"use client"

/**
 * Right-side image viewer drawer. Shared by:
 *   - attached image files (clicked thumbs in `MessageAttachments`)
 *   - generated images (Expand button in `GeneratedImagesGallery`)
 *
 * Single image → a static preview with a caption + action toolbar.
 * Multi-image target → prev / next chevrons + a count badge.
 *
 * Mounts inside `app/dashboard/page.tsx` as `<ImageViewerHost />`. Like
 * the other right-side viewers, it reads its target from a Zustand
 * store keyed in `right-panel-slot.ts` so any consumer can open it via
 * `openImageViewer({ images })`.
 */

import { useEffect, useState } from "react"
import {
  Copy,
  Download,
  ExternalLink,
  Repeat2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { formatBytes } from "@/shared/utils"
import { cn } from "@/shared/utils"
import { useStore } from "@/client/hooks/use-store"

import { useImageViewer, type ImageViewerItem } from "./types"

export function ImageViewerHost() {
  const target = useImageViewer((s) => s.target)
  const currentIndex = useImageViewer((s) => s.currentIndex)
  const close = useImageViewer((s) => s.close)
  const next = useImageViewer((s) => s.next)
  const prev = useImageViewer((s) => s.prev)

  // ←/→ navigate, Esc closes. Bound to window so the panel doesn't
  // need to own focus to receive arrow keys.
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        close()
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        next()
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        prev()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [target, close, next, prev])

  if (!target) return null
  const image = target.images[currentIndex] ?? null
  const hasMany = target.images.length > 1

  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) close() }}>
      <SheetContent
        side="right"
        className="w-full sm:w-[640px] sm:max-w-[80vw] p-0 gap-0 flex flex-col"
      >
        <SheetHeader className="shrink-0 pl-4 pr-12 py-3 border-b border-[var(--border)] space-y-0 flex-row items-center gap-2">
          <SheetTitle className="text-sm font-medium truncate flex-1 min-w-0">
            {imageTitle(image)}
          </SheetTitle>
          {hasMany && (
            <span className="shrink-0 text-[11px] text-[var(--muted-foreground)] tabular-nums">
              {currentIndex + 1} / {target.images.length}
            </span>
          )}
        </SheetHeader>

        {image ? (
          <>
            <ImagePane image={image} hasMany={hasMany} onPrev={prev} onNext={next} />
            <CaptionAndActions image={image} onAfterRemix={close} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-[var(--muted-foreground)] p-6">
            This image is unavailable.
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function imageTitle(image: ImageViewerItem | null): string {
  if (!image) return "Image"
  if (image.filename) return image.filename
  if (image.prompt) return truncate(image.prompt, 80)
  return "Image"
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

const MIN_IMG_SCALE = 0.5
const MAX_IMG_SCALE = 4
const IMG_SCALE_STEP = 0.25

function ImagePane({
  image,
  hasMany,
  onPrev,
  onNext,
}: {
  image: ImageViewerItem
  hasMany: boolean
  onPrev: () => void
  onNext: () => void
}) {
  // Per-image zoom — reset whenever the user navigates to a new image
  // so each one starts at fit-to-pane (`1x`).
  const [scale, setScale] = useState(1)
  useEffect(() => {
    setScale(1)
  }, [image.id])

  const zoomOut = () =>
    setScale((s) => clampScale(s - IMG_SCALE_STEP))
  const zoomIn = () =>
    setScale((s) => clampScale(s + IMG_SCALE_STEP))
  const resetZoom = () => setScale(1)

  return (
    <div className="relative flex-1 min-h-0 flex items-center justify-center bg-[var(--secondary)]/30 overflow-auto">
      {/* eslint-disable-next-line @next/next/no-img-element -- data: URLs +
          cross-origin signed URLs don't play nicely with next/image. */}
      <img
        src={image.url}
        alt={image.alt}
        className="max-w-full max-h-full object-contain transition-transform duration-150"
        style={{ transform: `scale(${scale})`, transformOrigin: "center center" }}
      />
      {hasMany && (
        <>
          <NavButton side="left" onClick={onPrev} />
          <NavButton side="right" onClick={onNext} />
        </>
      )}
      {/* Zoom controls — top-right overlay on the pane. Same shape as
          the PDF viewer's zoom cluster (Out / reset / In) so the muscle
          memory transfers. */}
      <div
        className={cn(
          "absolute top-2 right-2 z-10 flex items-center gap-0.5",
          "rounded-md bg-black/55 backdrop-blur-sm p-0.5 text-white"
        )}
      >
        <ZoomButton
          icon={ZoomOut}
          label="Zoom out"
          onClick={zoomOut}
          disabled={scale <= MIN_IMG_SCALE}
        />
        <button
          type="button"
          onClick={resetZoom}
          disabled={scale === 1}
          aria-label="Reset zoom"
          title="Reset zoom"
          className={cn(
            "min-w-[44px] h-6 px-1 rounded-sm text-[11px] tabular-nums",
            "inline-flex items-center justify-center gap-1",
            "text-white/85 hover:text-white hover:bg-white/15 disabled:opacity-50",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          )}
        >
          <RotateCcw size={10} />
          {Math.round(scale * 100)}%
        </button>
        <ZoomButton
          icon={ZoomIn}
          label="Zoom in"
          onClick={zoomIn}
          disabled={scale >= MAX_IMG_SCALE}
        />
      </div>
    </div>
  )
}

function clampScale(n: number): number {
  if (!Number.isFinite(n)) return 1
  if (n < MIN_IMG_SCALE) return MIN_IMG_SCALE
  if (n > MAX_IMG_SCALE) return MAX_IMG_SCALE
  // Snap to the nearest step so the percentage display stays tidy.
  return Math.round(n / IMG_SCALE_STEP) * IMG_SCALE_STEP
}

function ZoomButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof ZoomIn
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center justify-center h-6 w-6 rounded-sm",
        "text-white/85 hover:text-white hover:bg-white/15 disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      )}
    >
      <Icon size={12} />
    </button>
  )
}

function NavButton({
  side,
  onClick,
}: {
  side: "left" | "right"
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous image" : "Next image"}
      className={cn(
        "absolute top-1/2 -translate-y-1/2 h-10 w-10 rounded-full",
        "inline-flex items-center justify-center text-2xl",
        "bg-black/35 text-white hover:bg-black/55 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        side === "left" ? "left-2" : "right-2"
      )}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  )
}

function CaptionAndActions({
  image,
  onAfterRemix,
}: {
  image: ImageViewerItem
  /** Close the panel after a remix is staged so the user sees the
   *  reference chip in the chat input. */
  onAfterRemix: () => void
}) {
  const setPendingReferenceImage = useStore(
    (s) => s.setPendingReferenceImage
  )
  const remixable = canRemix(image.url)
  const subline = subtitleFor(image)

  const handleDownload = () => {
    try {
      const a = document.createElement("a")
      a.href = image.url
      a.download = downloadName(image)
      a.click()
    } catch {
      toast.error("Download failed")
    }
  }
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(image.url)
      toast.success(image.url.startsWith("data:") ? "Data URL copied" : "URL copied")
    } catch {
      toast.error("Copy failed")
    }
  }
  const handleOpen = () => {
    if (image.url.startsWith("data:")) {
      toast.info("Open-in-tab isn't supported for data: URLs — downloading instead")
      handleDownload()
      return
    }
    window.open(image.url, "_blank", "noopener,noreferrer")
  }
  const handleRemix = () => {
    setPendingReferenceImage({
      url: image.url,
      sourcePrompt: image.prompt,
    })
    toast.success("Reference set — describe your variation and send")
    onAfterRemix()
  }

  return (
    <div className="shrink-0 border-t border-[var(--border)] px-4 py-3 space-y-2.5">
      {/* Prompt / filesize line */}
      {(image.prompt || subline) && (
        <div className="space-y-1">
          {image.prompt && (
            <p className="text-xs text-[var(--muted-foreground)] italic leading-relaxed">
              {image.prompt}
            </p>
          )}
          {subline && (
            <p className="text-[11px] text-[var(--muted-foreground)]/80">
              {subline}
            </p>
          )}
        </div>
      )}
      {/* Actions row */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
          <Download size={13} />
          <span className="text-xs">Download</span>
        </Button>
        <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5">
          <Copy size={13} />
          <span className="text-xs">Copy URL</span>
        </Button>
        <Button variant="outline" size="sm" onClick={handleOpen} className="gap-1.5">
          <ExternalLink size={13} />
          <span className="text-xs">Open</span>
        </Button>
        {remixable && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRemix}
            className="gap-1.5"
          >
            <Repeat2 size={13} />
            <span className="text-xs">Remix</span>
          </Button>
        )}
      </div>
    </div>
  )
}

function subtitleFor(image: ImageViewerItem): string {
  const parts: string[] = []
  if (image.mode) parts.push(image.mode === "i2i" ? "remixed" : "generated")
  if (typeof image.sizeBytes === "number" && image.sizeBytes > 0) {
    parts.push(formatBytes(image.sizeBytes))
  }
  if (image.format) parts.push(image.format.toUpperCase())
  return parts.join(" · ")
}

function downloadName(image: ImageViewerItem): string {
  if (image.filename) return image.filename
  const ext = (image.format ?? "png").replace(/^\./, "")
  return `image-${image.id}.${ext}`
}

/** Minimax fetches the `referenceImageUrl` server-side, so the URL has
 *  to be reachable from their network. data: and blob: URLs don't work
 *  — hide Remix in those cases. */
function canRemix(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://")
}
