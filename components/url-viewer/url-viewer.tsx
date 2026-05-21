"use client"

/**
 * URL bookmark preview drawer. Slides in from the right (same Sheet
 * pattern as <PdfViewerHost/>) and shows the extracted contents of a
 * saved web page so users can skim it without round-tripping to the
 * source site.
 *
 * Content rendered is the server-side extraction stored on the
 * UrlBookmark row (plain text, paragraph breaks preserved). For images
 * we'd want a richer treatment, but extraction strips them by design —
 * this is a *reading* surface, not a re-rendering of the source page.
 *
 * Layout: a single "info block" up top (favicon + title + host/meta +
 * optional summary + action row), then a divider, then a clean reading
 * surface. Each region has its own job — header is for orientation +
 * actions, body is for content.
 */

import { Copy, ExternalLink, Globe, RefreshCw } from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useStore, useWorkspaceUrlBookmarks } from "@/client/hooks/use-store"
import { apiClient } from "@/client/api-client"
import { copyText } from "@/client/export"
import { cn } from "@/shared/utils"
import type { UrlBookmark } from "@/shared/types"

import { useUrlPreview } from "./types"

export function UrlPreviewHost() {
  const target = useUrlPreview((s) => s.target)
  const close = useUrlPreview((s) => s.close)
  if (!target) return null
  return <UrlPreview bookmarkId={target.bookmarkId} onClose={close} />
}

interface UrlPreviewProps {
  bookmarkId: string
  onClose: () => void
}

function UrlPreview({ bookmarkId, onClose }: UrlPreviewProps) {
  const bookmark = useWorkspaceUrlBookmarks().find((b) => b.id === bookmarkId)
  const updateUrlBookmark = useStore((s) => s.updateUrlBookmark)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    if (!bookmark || refreshing) return
    setRefreshing(true)
    try {
      const result = await apiClient.url.fetch(bookmark.url)
      if (!result.ok) {
        toast.error(result.error.message ?? "Refresh failed", {
          description: result.error.code,
        })
        return
      }
      // Store bumps `fetchedAt` + `updatedAt` itself — patch only the
      // content fields the server returned.
      updateUrlBookmark(bookmark.id, {
        title: result.bookmark.title,
        content: result.bookmark.content,
        contentTruncated: result.bookmark.contentTruncated,
        contentHash: result.bookmark.contentHash,
        description: result.bookmark.description,
        faviconUrl: result.bookmark.faviconUrl,
      })
      toast.success("Bookmark refreshed")
    } finally {
      setRefreshing(false)
    }
  }

  const handleCopy = async () => {
    if (!bookmark) return
    await copyText(bookmark.url)
    toast.success("URL copied")
  }

  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent
        side="right"
        className="w-full sm:w-[640px] sm:max-w-[80vw] p-0 gap-0 flex flex-col"
      >
        {bookmark ? (
          <>
            <InfoBlock
              bookmark={bookmark}
              refreshing={refreshing}
              onRefresh={handleRefresh}
              onCopy={handleCopy}
            />
            <Body bookmark={bookmark} />
          </>
        ) : (
          <>
            {/* Keep a SheetTitle for a11y even on the empty state. */}
            <SheetHeader className="shrink-0 pl-4 pr-12 py-3 border-b border-[var(--border)] space-y-0">
              <SheetTitle className="text-sm font-medium">
                Bookmark unavailable
              </SheetTitle>
            </SheetHeader>
            <div className="flex-1 flex items-center justify-center text-sm text-[var(--muted-foreground)] p-6">
              This bookmark was removed.
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/**
 * Top info block — favicon + title + host/meta + optional summary +
 * action row. One zone, breathable spacing, actions are labelled
 * buttons (not icon-only) so they read as primary affordances rather
 * than nav crumbs.
 */
function InfoBlock({
  bookmark,
  refreshing,
  onRefresh,
  onCopy,
}: {
  bookmark: UrlBookmark
  refreshing: boolean
  onRefresh: () => void
  onCopy: () => void
}) {
  return (
    // `pr-12` reserves space for the Radix-default close X (absolute
    // top-4 right-4). Everything else gets normal padding.
    <SheetHeader className="shrink-0 px-4 pr-12 pt-4 pb-3 border-b border-[var(--border)] space-y-3">
      {/* Row 1: favicon (large) + title block (title + host + meta). */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 size-9 rounded-md bg-[var(--muted)] border border-[var(--border)] inline-flex items-center justify-center overflow-hidden">
          {bookmark.faviconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={bookmark.faviconUrl}
              alt=""
              className="size-5"
              onError={(e) => {
                ;(e.currentTarget as HTMLImageElement).style.display = "none"
              }}
            />
          ) : (
            <Globe size={16} className="text-[var(--muted-foreground)]" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <SheetTitle
            className="text-sm font-medium leading-snug line-clamp-2"
            title={bookmark.title}
          >
            {bookmark.title}
          </SheetTitle>
          <p className="mt-1 text-[11px] text-[var(--muted-foreground)] flex items-center gap-1.5 flex-wrap">
            <span className="truncate" title={bookmark.url}>
              {stripScheme(bookmark.url)}
            </span>
            <span className="opacity-50">·</span>
            <span
              title={format(new Date(bookmark.fetchedAt), "MMM d, yyyy · h:mm a")}
              className="whitespace-nowrap"
            >
              Fetched {formatDistanceToNow(new Date(bookmark.fetchedAt), { addSuffix: true })}
            </span>
            {bookmark.contentTruncated && (
              <>
                <span className="opacity-50">·</span>
                <span className="text-amber-600 dark:text-amber-500 whitespace-nowrap">
                  Truncated
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      {/* Row 2: summary (the site's meta description), when present.
          Plain text in muted color — no italic / border treatment,
          which read as a quote in the old design. */}
      {bookmark.description && (
        <p className="text-xs text-[var(--muted-foreground)] leading-relaxed line-clamp-3">
          {bookmark.description}
        </p>
      )}

      {/* Row 3: action row — labelled buttons. Reads as a toolbar. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          asChild
          className="h-7 gap-1.5 text-xs"
        >
          <a
            href={bookmark.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open original page in new tab"
          >
            <ExternalLink size={12} />
            Open
          </a>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="h-7 gap-1.5 text-xs"
          aria-label="Refresh bookmark"
          title="Re-fetch this URL"
        >
          <RefreshCw size={12} className={cn(refreshing && "animate-spin")} />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onCopy}
          className="h-7 gap-1.5 text-xs"
          aria-label="Copy URL"
        >
          <Copy size={12} />
          Copy URL
        </Button>
      </div>
    </SheetHeader>
  )
}

/** Pure body — just the extracted content, scrollable. */
function Body({ bookmark }: { bookmark: UrlBookmark }) {
  const hasContent = bookmark.content.trim().length > 0
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
      {hasContent ? (
        // Preformatted-wrap preserves the extractor's paragraph breaks
        // without forcing a horizontal scrollbar on long lines.
        <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-sans text-[var(--foreground)]">
          {bookmark.content}
        </pre>
      ) : (
        <p className="text-xs text-[var(--muted-foreground)]">
          The server couldn&apos;t extract any text from this page. Try
          refreshing, or open the original.
        </p>
      )}
    </div>
  )
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}
