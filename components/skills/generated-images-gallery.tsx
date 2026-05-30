"use client"

import "client-only"

import { useRef } from "react"
import { Copy, Download, ExternalLink, Maximize2, Repeat2 } from "lucide-react"
import { toast } from "sonner"

import { apiClient } from "@/client/api-client"
import type { GeneratedImage } from "@/shared/types"
import { useStore } from "@/client/hooks/use-store"
import { cn } from "@/shared/utils"
import { openImageViewer } from "@/components/right-panel-slot"
import type { ImageViewerItem } from "@/components/image-viewer/types"

/** Minimax fetches the `referenceImageUrl` server-side, so the reference
 *  has to be a URL their network can resolve. Signed Supabase Storage
 *  URLs work; `data:` and `blob:` URLs do not — we hide the Remix button
 *  in those cases rather than failing later inside the tool. */
function canRemix(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://")
}

/** Stage a gallery image as the next turn's I2I reference. Shared
 *  between the lightbox action and the inline tile-hover button so the
 *  toast wording stays in sync. */
function stageRemix(
  image: GeneratedImage,
  setPending: (
    v: { url: string; sourcePrompt?: string } | null
  ) => void
) {
  setPending({ url: image.url, sourcePrompt: image.prompt })
  toast.success("Reference set — describe your variation and send")
}

/**
 * Renders the images the `imageGen` skill produced for an assistant
 * message. Layout adapts to count:
 *
 *   1 image → full-width hero card (max-height capped)
 *   2 images → 2-up row
 *   3 images → first wide, two stacked
 *   4 images → 2×2 grid
 *
 * The inline view is the primary surface — clicking the Expand button
 * in each tile's hover toolbar routes through `openImageViewer(...)`
 * (the shared right-side image-viewer drawer, same one attached image
 * files use), keeping the chat scroll uninterrupted while a fullscreen
 * preview is available next to it.
 */
export function GeneratedImagesGallery({
  images,
  messageId,
}: {
  images: GeneratedImage[]
  /** Owning message id — required to wire the lazy signed-URL re-sign
   *  path (`<img onError>` → `apiClient.images.refreshUrl` → store
   *  mutator). When omitted, an expired image falls back to the
   *  browser's broken-image placeholder (the preview surfaces that
   *  embed the gallery outside a real conversation pass nothing). */
  messageId?: string
}) {
  if (images.length === 0) return null
  const openAt = (i: number) =>
    openImageViewer({
      images: images.map(toViewerItem),
      initialIndex: i,
    })

  return (
    <div className="mt-2 mb-1">
      <GalleryLayout images={images} onOpen={openAt} messageId={messageId} />
      <p className="mt-1.5 text-[11px] text-[var(--muted-foreground)] italic">
        {captionFor(images)}
      </p>
    </div>
  )
}

function toViewerItem(image: GeneratedImage): ImageViewerItem {
  return {
    id: image.id,
    url: image.url,
    alt: image.prompt,
    format: image.format,
    prompt: image.prompt,
    mode: image.mode,
  }
}

function GalleryLayout({
  images,
  onOpen,
  messageId,
}: {
  images: GeneratedImage[]
  onOpen: (i: number) => void
  messageId?: string
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
          messageId={messageId}
        />
      ))}
    </div>
  )
}

function ImageTile({
  image,
  onOpen,
  single,
  messageId,
}: {
  image: GeneratedImage
  /** Called by the Expand button to open the lightbox at this tile's
   *  index. The image itself is no longer click-to-expand — the user
   *  acts via the hover toolbar instead. */
  onOpen: () => void
  single: boolean
  messageId?: string
}) {
  const remixable = canRemix(image.url)
  const updateMessageGeneratedImageUrl = useStore(
    (s) => s.updateMessageGeneratedImageUrl
  )
  // Prevent an infinite refresh loop on a path that refuses to re-sign
  // (object deleted out-of-band, RLS reject, etc.). One attempt per tile
  // mount; the broken-image placeholder takes over after that.
  const refreshAttempted = useRef(false)
  // Only worth attempting when (1) the URL came from Supabase Storage
  // (has a `storagePath`) and (2) we know which message to update
  // afterwards. Data-URL fallbacks and orphan previews skip the refresh.
  const canRefresh = !!image.storagePath && !!messageId
  return (
    <div
      className={cn(
        "group relative w-fit overflow-hidden rounded-md border border-[var(--border)] bg-[var(--muted)]/30",
        // Inline view is now the primary surface — bigger than before
        // so users can actually see the image without enlarging. The
        // lightbox stays available via the Expand button in the hover
        // toolbar for full-resolution viewing.
        single
          ? "max-w-[640px] max-h-[480px]"
          : "max-w-[360px] max-h-[280px]"
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
        onError={
          canRefresh
            ? async () => {
                if (refreshAttempted.current) return
                refreshAttempted.current = true
                const fresh = await apiClient.images.refreshUrl(
                  image.storagePath!
                )
                if (fresh) {
                  updateMessageGeneratedImageUrl(messageId!, image.id, fresh)
                }
              }
            : undefined
        }
      />
      {image.mode === "i2i" && (
        <span className="pointer-events-none absolute top-1.5 left-1.5 text-[10px] font-medium uppercase tracking-wide bg-black/55 text-white px-1.5 py-0.5 rounded-sm">
          remix
        </span>
      )}
      {/* Hover/focus toolbar — icon-only buttons over a dark semi-
          transparent backplate so they read on any background. The
          Expand button opens the lightbox; everything else acts
          directly on the image. Hidden until hover/focus to keep the
          inline view clean. */}
      <div
        className={cn(
          "absolute top-1.5 right-1.5 z-10 flex items-center gap-1",
          "rounded-md bg-black/55 backdrop-blur-sm p-0.5",
          "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          "transition-opacity"
        )}
      >
        <TileActionButton
          icon={Maximize2}
          label="Expand"
          onClick={onOpen}
        />
        <TileActionButton image={image} kind="download" />
        <TileActionButton image={image} kind="copy" />
        <TileActionButton image={image} kind="open" />
        {remixable && <TileActionButton image={image} kind="remix" />}
      </div>
    </div>
  )
}

/**
 * Compact icon button for the inline hover toolbar. Two modes:
 *   - Generic (`onClick` + `icon` + `label`) — used by the Expand
 *     button.
 *   - Bound to a known action kind (`image` + `kind`) — reuses the
 *     same handlers as the lightbox `ActionButton` for download / copy
 *     / open / remix.
 */
function TileActionButton(
  props:
    | {
        icon: typeof Maximize2
        label: string
        onClick: () => void
        image?: never
        kind?: never
      }
    | {
        image: GeneratedImage
        kind: "download" | "copy" | "open" | "remix"
        icon?: never
        label?: never
        onClick?: never
      }
) {
  const setPendingReferenceImage = useStore(
    (s) => s.setPendingReferenceImage
  )
  let Icon: typeof Maximize2
  let label: string
  let onClick: () => void | Promise<void>
  if (props.icon) {
    Icon = props.icon
    label = props.label
    onClick = props.onClick
  } else {
    const { image, kind } = props
    Icon =
      kind === "download"
        ? Download
        : kind === "copy"
          ? Copy
          : kind === "remix"
            ? Repeat2
            : ExternalLink
    label =
      kind === "download"
        ? "Download"
        : kind === "copy"
          ? "Copy URL"
          : kind === "remix"
            ? "Remix"
            : "Open in new tab"
    onClick = async () => {
      if (kind === "download") {
        try {
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
      } else if (kind === "remix") {
        stageRemix(image, setPendingReferenceImage)
      } else {
        if (image.url.startsWith("data:")) {
          toast.info("Open-in-tab isn't supported for data: URLs — downloading instead")
          const a = document.createElement("a")
          a.href = image.url
          a.download = `image-${image.id}.${image.format}`
          a.click()
        } else {
          window.open(image.url, "_blank", "noopener,noreferrer")
        }
      }
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center justify-center h-6 w-6 rounded-sm",
        "text-white/85 hover:text-white hover:bg-white/15",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      )}
    >
      <Icon size={12} />
    </button>
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
