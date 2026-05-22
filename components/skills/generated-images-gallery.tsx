"use client"

import "client-only"

import { useCallback, useEffect, useState } from "react"
import { Copy, Download, ExternalLink, X } from "lucide-react"
import { toast } from "sonner"

import type { GeneratedImage } from "@/shared/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/shared/utils"

/**
 * Renders the images the `imageGen` skill produced for an assistant
 * message. Layout adapts to count:
 *
 *   1 image → full-width hero card (max-height capped)
 *   2 images → 2-up row
 *   3 images → first wide, two stacked
 *   4 images → 2×2 grid
 *
 * Clicking an image opens the lightbox. Hover surfaces actions
 * (download, copy URL, open in new tab). All actions are no-ops on
 * data: URLs that the browser would refuse to navigate (we still
 * download successfully).
 */
export function GeneratedImagesGallery({
  images,
}: {
  images: GeneratedImage[]
}) {
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)
  const close = useCallback(() => setLightboxIdx(null), [])
  // Esc closes the lightbox. Added once when the lightbox is open;
  // useEffect's cleanup detaches it.
  useEffect(() => {
    if (lightboxIdx === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
      else if (e.key === "ArrowRight" && lightboxIdx < images.length - 1)
        setLightboxIdx(lightboxIdx + 1)
      else if (e.key === "ArrowLeft" && lightboxIdx > 0)
        setLightboxIdx(lightboxIdx - 1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [lightboxIdx, images.length, close])
  if (images.length === 0) return null
  const open = (i: number) => setLightboxIdx(i)

  return (
    <>
      <div className="mt-2 mb-1">
        <GalleryLayout images={images} onOpen={open} />
        <p className="mt-1.5 text-[11px] text-[var(--muted-foreground)] italic">
          {captionFor(images)}
        </p>
      </div>
      {lightboxIdx !== null && (
        <Lightbox
          images={images}
          index={lightboxIdx}
          onIndex={setLightboxIdx}
          onClose={close}
        />
      )}
    </>
  )
}

function GalleryLayout({
  images,
  onOpen,
}: {
  images: GeneratedImage[]
  onOpen: (i: number) => void
}) {
  // Single, double, quad → straightforward grids. The "3" case picks
  // the same 2×2 grid as 4 with the last slot empty rather than
  // inventing a special-case shape that confuses the eye.
  const gridClass =
    images.length === 1
      ? "grid grid-cols-1"
      : images.length === 2
        ? "grid grid-cols-2 gap-2"
        : "grid grid-cols-2 gap-2"
  return (
    <div className={gridClass}>
      {images.map((img, i) => (
        <ImageTile
          key={img.id}
          image={img}
          onOpen={() => onOpen(i)}
          // Single hero gets a tighter max-height so it doesn't
          // overflow short chat panels.
          single={images.length === 1}
        />
      ))}
    </div>
  )
}

function ImageTile({
  image,
  onOpen,
  single,
}: {
  image: GeneratedImage
  onOpen: () => void
  single: boolean
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open image: ${image.prompt.slice(0, 80)}`}
      className={cn(
        "group relative overflow-hidden rounded-md border border-[var(--border)] bg-[var(--muted)]/30",
        "transition-shadow hover:shadow-md hover:border-[var(--muted-foreground)]/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/40",
        single ? "max-h-[420px]" : "max-h-[260px]"
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- data: URLs
          and possibly cross-origin signed URLs don't play with next/image's
          loader; the unoptimized fallback would be more complexity than
          this needs. */}
      <img
        src={image.url}
        alt={image.prompt}
        loading="lazy"
        className="block w-full h-auto object-cover"
      />
      {image.mode === "i2i" && (
        <span className="absolute top-1.5 left-1.5 text-[10px] font-medium uppercase tracking-wide bg-black/55 text-white px-1.5 py-0.5 rounded-sm">
          remix
        </span>
      )}
    </button>
  )
}

function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: GeneratedImage[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
}) {
  const img = images[index]
  if (!img) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
      onClick={onClose}
    >
      <div
        className="relative max-w-[92vw] max-h-[92vh] flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={img.url}
          alt={img.prompt}
          className="max-w-[92vw] max-h-[80vh] object-contain rounded-md shadow-2xl"
        />
        <div className="flex items-center gap-2">
          <ActionButton image={img} kind="download" />
          <ActionButton image={img} kind="copy" />
          <ActionButton image={img} kind="open" />
          {images.length > 1 && (
            <span className="text-xs text-white/70 px-2">
              {index + 1} / {images.length}
            </span>
          )}
        </div>
        <p className="max-w-[80vw] text-xs text-white/80 italic text-center">
          {img.prompt}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close image viewer"
          className="absolute -top-10 right-0 text-white/80 hover:text-white"
        >
          <X size={20} />
        </button>
        {images.length > 1 && (
          <>
            {index > 0 && (
              <button
                type="button"
                aria-label="Previous image"
                onClick={() => onIndex(index - 1)}
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-12 text-white/70 hover:text-white text-3xl px-2"
              >
                ‹
              </button>
            )}
            {index < images.length - 1 && (
              <button
                type="button"
                aria-label="Next image"
                onClick={() => onIndex(index + 1)}
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-12 text-white/70 hover:text-white text-3xl px-2"
              >
                ›
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ActionButton({
  image,
  kind,
}: {
  image: GeneratedImage
  kind: "download" | "copy" | "open"
}) {
  const handle = async () => {
    if (kind === "download") {
      try {
        // Works for both data: and remote URLs. `download` attribute
        // gives the browser a hint at the filename.
        const a = document.createElement("a")
        a.href = image.url
        a.download = `image-${image.id}.${image.format}`
        a.click()
      } catch {
        toast.error("Download failed")
      }
    } else if (kind === "copy") {
      try {
        await navigator.clipboard.writeText(image.url)
        toast.success(image.url.startsWith("data:") ? "Data URL copied" : "URL copied")
      } catch {
        toast.error("Copy failed")
      }
    } else {
      // Open in new tab — works for remote URLs; browsers refuse to
      // navigate to data: URLs in modern versions. Fall back to
      // download in that case.
      if (image.url.startsWith("data:")) {
        toast.info("Open-in-tab isn't supported for data: URLs — downloading instead")
        const a = document.createElement("a")
        a.href = image.url
        a.download = `image-${image.id}.${image.format}`
        a.click()
        return
      }
      window.open(image.url, "_blank", "noopener,noreferrer")
    }
  }
  const Icon = kind === "download" ? Download : kind === "copy" ? Copy : ExternalLink
  const label = kind === "download" ? "Download" : kind === "copy" ? "Copy URL" : "Open in new tab"
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={handle}
      className="gap-1.5 bg-white/10 text-white hover:bg-white/20 border-white/20"
      aria-label={label}
    >
      <Icon size={14} />
      <span className="text-xs">{label}</span>
    </Button>
  )
}

function captionFor(images: GeneratedImage[]): string {
  if (images.length === 0) return ""
  const mode = images[0].mode === "i2i" ? "remixed" : "generated"
  const n = images.length
  return n === 1
    ? `${cap(mode)} from: "${truncate(images[0].prompt, 120)}"`
    : `${n} images ${mode} from: "${truncate(images[0].prompt, 120)}"`
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}
