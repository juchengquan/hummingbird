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

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Download,
  ExternalLink,
  Repeat2,
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
import { PreviewHeader } from "@/components/preview/preview-header"
import { cn } from "@/shared/utils"
import { useStore } from "@/client/hooks/use-store"

import { useImageViewer, type ImageViewerItem } from "./types"

export function ImageViewerHost() {
  const target = useImageViewer((s) => s.target)
  const currentIndex = useImageViewer((s) => s.currentIndex)
  const close = useImageViewer((s) => s.close)
  const next = useImageViewer((s) => s.next)
  const prev = useImageViewer((s) => s.prev)

  // Zoom state lives at the host so the header can render the controls
  // (matching the PDF viewer's pattern) while the pane applies them.
  // Reset on image change so each one starts at fit-to-pane (100%).
  const [scale, setScale] = useState(1)
  useEffect(() => {
    setScale(1)
  }, [currentIndex, target])

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

  // Action handlers — Download / Open in new tab. Copy URL is handled
  // automatically by PreviewHeader via the `copyUrl` prop.
  const handleDownload = () => {
    if (!image) return
    try {
      const a = document.createElement("a")
      a.href = image.url
      a.download = downloadName(image)
      a.click()
    } catch {
      toast.error("Download failed")
    }
  }
  const handleOpen = () => {
    if (!image) return
    if (image.url.startsWith("data:")) {
      toast.info("Open-in-tab isn't supported for data: URLs — downloading instead")
      handleDownload()
      return
    }
    window.open(image.url, "_blank", "noopener,noreferrer")
  }

  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) close() }}>
      <SheetContent
        side="right"
        className="w-full sm:w-[640px] sm:max-w-[80vw] p-0 gap-0 flex flex-col"
      >
        <SheetHeader className="shrink-0 pl-4 pr-12 py-2.5 border-b border-[var(--border)] space-y-0">
          <SheetTitle className="sr-only">{imageTitle(image)}</SheetTitle>
          <PreviewHeader
            title={imageTitle(image)}
            sizeBytes={image?.sizeBytes}
            typeLabel={image?.format?.toUpperCase()}
            controls={
              image && (
                <div className="flex items-center gap-1">
                  {hasMany && (
                    <>
                      <span className="text-xs tabular-nums text-[var(--muted-foreground)]">
                        {currentIndex + 1} / {target.images.length}
                      </span>
                      <span className="mx-1 h-4 w-px bg-[var(--border)]" />
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setScale((s) => clampScale(s - IMG_SCALE_STEP))}
                    disabled={scale <= MIN_IMG_SCALE}
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
                    onClick={() => setScale((s) => clampScale(s + IMG_SCALE_STEP))}
                    disabled={scale >= MAX_IMG_SCALE}
                    className="h-7 w-7 text-[var(--muted-foreground)]"
                    aria-label="Zoom in"
                  >
                    <ZoomIn size={14} />
                  </Button>
                </div>
              )
            }
            actions={
              image
                ? [
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
            copyUrl={image?.url}
          />
        </SheetHeader>

        {image ? (
          <>
            <ImagePane
              image={image}
              hasMany={hasMany}
              onPrev={prev}
              onNext={next}
              scale={scale}
            />
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
  scale,
}: {
  image: ImageViewerItem
  hasMany: boolean
  onPrev: () => void
  onNext: () => void
  /** Owned by the host so the header's zoom controls and this pane
   *  read from the same source. */
  scale: number
}) {
  // Drag-to-pan state. CSS transforms don't affect layout, so the
  // parent's `overflow` can't scroll a zoomed image — we have to apply
  // an explicit `translate(...)` and react to pointer drags ourselves.
  // Translate is clamped each frame so the image can't slide entirely
  // off the visible pane.
  const paneRef = useRef<HTMLDivElement>(null)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<
    { startX: number; startY: number; baseX: number; baseY: number } | null
  >(null)

  // Reset pan whenever the image or zoom level changes. Without this the
  // previous image's offset would persist into the next one, and zooming
  // back to 100% would leave the image visually off-centre.
  useEffect(() => {
    setTranslate({ x: 0, y: 0 })
  }, [scale, image])

  const clampTranslate = useCallback(
    (x: number, y: number) => {
      if (scale <= 1) return { x: 0, y: 0 }
      const el = paneRef.current
      if (!el) return { x, y }
      // The actual zoomed image is at most `clientWidth * scale` wide
      // (it was `object-contain`-ed before the transform). Allowed pan
      // is half of the *overflow* in each direction.
      const maxX = (el.clientWidth * (scale - 1)) / 2
      const maxY = (el.clientHeight * (scale - 1)) / 2
      return {
        x: Math.max(-maxX, Math.min(maxX, x)),
        y: Math.max(-maxY, Math.min(maxY, y)),
      }
    },
    [scale]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // No reason to drag at 1×; let the navigation buttons / sheet click
    // close still work normally without a pan-capture in the way.
    if (scale <= 1) return
    // Only left mouse / primary touch.
    if (e.button !== 0 && e.pointerType === "mouse") return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: translate.x,
      baseY: translate.y,
    }
    setDragging(true)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setTranslate(
      clampTranslate(
        drag.baseX + (e.clientX - drag.startX),
        drag.baseY + (e.clientY - drag.startY)
      )
    )
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // ignore — capture may have been released by the browser already.
    }
  }

  const panEnabled = scale > 1
  return (
    <div
      ref={paneRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={cn(
        "relative flex-1 min-h-0 flex items-center justify-center bg-[var(--secondary)]/30 overflow-hidden select-none",
        panEnabled && (dragging ? "cursor-grabbing" : "cursor-grab")
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- data: URLs +
          cross-origin signed URLs don't play nicely with next/image. */}
      <img
        src={image.url}
        alt={image.alt}
        draggable={false}
        className={cn(
          "max-w-full max-h-full object-contain will-change-transform",
          // Skip the transition during active drag — otherwise the
          // image lags behind the cursor by 150ms and feels broken.
          !dragging && "transition-transform duration-150"
        )}
        style={{
          transform: `translate3d(${translate.x}px, ${translate.y}px, 0) scale(${scale})`,
          transformOrigin: "center center",
        }}
      />
      {hasMany && (
        <>
          <NavButton side="left" onClick={onPrev} />
          <NavButton side="right" onClick={onNext} />
        </>
      )}
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
  // Download / Copy URL / Open now live in PreviewHeader. The footer
  // keeps only image-specific affordances — the prompt caption and the
  // Remix button (image-gen-only action, no equivalent on other
  // viewers). If there's nothing to caption AND no remix, the footer
  // is hidden entirely so we don't waste vertical space.
  const handleRemix = () => {
    setPendingReferenceImage({
      url: image.url,
      sourcePrompt: image.prompt,
    })
    toast.success("Reference set — describe your variation and send")
    onAfterRemix()
  }

  const generatedLabel = image.mode === "i2i" ? "remixed" : image.mode === "t2i" ? "generated" : null
  if (!image.prompt && !generatedLabel && !remixable) return null

  return (
    <div className="shrink-0 border-t border-[var(--border)] px-4 py-3 space-y-2.5">
      {(image.prompt || generatedLabel) && (
        <div className="space-y-1">
          {image.prompt && (
            <p className="text-xs text-[var(--muted-foreground)] italic leading-relaxed">
              {image.prompt}
            </p>
          )}
          {generatedLabel && (
            <p className="text-[11px] text-[var(--muted-foreground)]/80">
              {generatedLabel}
            </p>
          )}
        </div>
      )}
      {remixable && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={handleRemix} className="gap-1.5">
            <Repeat2 size={13} />
            <span className="text-xs">Remix</span>
          </Button>
        </div>
      )}
    </div>
  )
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
