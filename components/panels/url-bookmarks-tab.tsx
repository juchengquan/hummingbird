"use client"

import { useCallback, useMemo, useState } from "react"
import { format, formatDistanceToNow } from "date-fns"
import { Eye, ExternalLink, Globe, Plus, RefreshCw, Search, X } from "lucide-react"

import { openUrlPreview } from "@/components/right-panel-slot"
import { toast } from "sonner"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  useStore,
  useConversationSelectedUrlBookmarkIds,
  useWorkspaceUrlBookmarks,
} from "@/client/hooks/use-store"
import { apiClient } from "@/client/api-client"
import { TabEmptyState } from "@/components/panels/tab-empty-state"
import { cn, stripUrlScheme } from "@/shared/utils"
import type { UrlBookmark } from "@/shared/types"

/**
 * URL bookmarks tab — saved web pages, third source type after files
 * and MCP. Mirrors the MCP tab's two-stack layout:
 *   - "This conversation" pinned bookmarks (private lane).
 *   - "Workspace bookmarks" — tickable rows backed by
 *     `selectedUrlBookmarkIds` on the conversation.
 *
 * Add flow: paste URL → server fetches + extracts → row appears with
 * favicon + title + last-fetched timestamp. Each row has a Refresh
 * button that re-fetches and updates the cached content in place.
 */
export function UrlBookmarksTab() {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaceBookmarks = useWorkspaceUrlBookmarks()
  const selectedIds = useConversationSelectedUrlBookmarkIds()

  const addUrlBookmark = useStore((s) => s.addUrlBookmark)
  const updateUrlBookmark = useStore((s) => s.updateUrlBookmark)
  const removeUrlBookmark = useStore((s) => s.removeUrlBookmark)
  const toggleSelection = useStore(
    (s) => s.toggleConversationUrlBookmarkSelection
  )

  const [query, setQuery] = useState("")
  const [addOpen, setAddOpen] = useState<"workspace" | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    if (!query.trim()) return workspaceBookmarks
    const q = query.toLowerCase()
    return workspaceBookmarks.filter(b =>
      b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)
    )
  }, [workspaceBookmarks, query])

  const handleAdd = useCallback(
    async (url: string) => {
      const result = await apiClient.url.fetch(url)
      if (!result.ok) {
        toast.error(result.error.message ?? "Failed to fetch URL", {
          description: result.error.code,
        })
        return
      }
      const bookmark = addUrlBookmark({
        workspaceId: activeWorkspaceId,
        url: result.bookmark.url,
        title: result.bookmark.title,
        content: result.bookmark.content,
        contentTruncated: result.bookmark.contentTruncated,
        contentHash: result.bookmark.contentHash,
        description: result.bookmark.description,
        faviconUrl: result.bookmark.faviconUrl,
      })
      toggleSelection(bookmark.id)
      const truncatedNote = result.bookmark.contentTruncated
        ? " (truncated at 200 KB)"
        : ""
      toast.success(`Saved "${bookmark.title}"`, {
        description: `${result.bookmark.content.length.toLocaleString()} chars${truncatedNote}`,
      })
      setAddOpen(null)
    },
    [activeWorkspaceId, addUrlBookmark, toggleSelection]
  )

  const handleRefresh = useCallback(
    async (bookmark: UrlBookmark) => {
      setRefreshingId(bookmark.id)
      try {
        const result = await apiClient.url.fetch(bookmark.url)
        if (!result.ok) {
          toast.error(result.error.message ?? "Refresh failed", {
            description: result.error.code,
          })
          return
        }
        const changed = result.bookmark.contentHash !== bookmark.contentHash
        updateUrlBookmark(bookmark.id, {
          title: result.bookmark.title,
          content: result.bookmark.content,
          contentTruncated: result.bookmark.contentTruncated,
          contentHash: result.bookmark.contentHash,
          description: result.bookmark.description,
          faviconUrl: result.bookmark.faviconUrl,
        })
        toast.success(
          changed
            ? `Refreshed "${bookmark.title}" — content updated`
            : `Refreshed "${bookmark.title}" — no changes`
        )
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Refresh failed")
      } finally {
        setRefreshingId(null)
      }
    },
    [updateUrlBookmark]
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Workspace bookmarks — tickable rows. */}
      <div className="flex-1 min-h-0 flex flex-col border-t border-[var(--border)]">
        <div className="shrink-0 h-11 px-3 flex items-center justify-between gap-2 border-b border-[var(--border)]">
          <div className="flex items-center gap-1.5 min-w-0">
            <Globe size={11} className="shrink-0 text-[var(--muted-foreground)]" />
            <p className="text-[11px] font-medium text-[var(--foreground)] truncate">
              Bookmarks
            </p>
            <span className="text-[10px] text-[var(--muted-foreground)] shrink-0">
              {workspaceBookmarks.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAddOpen("workspace")}
            aria-label="Add a bookmark to the workspace"
            title="Add a bookmark to the workspace"
            className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Search */}
        <div className="shrink-0 px-3 py-2 border-b border-[var(--border)]">
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search bookmarks"
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
          {workspaceBookmarks.length === 0 ? (
            <TabEmptyState icon={Globe} onClick={() => setAddOpen("workspace")}>
              No bookmarks yet. Add a URL to save it as workspace context.
            </TabEmptyState>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-[var(--muted-foreground)]">
              No bookmarks match &ldquo;{query}&rdquo;
            </div>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((bookmark) => {
                const attached = selectedIds.includes(bookmark.id)
                return (
                  <BookmarkRow
                    key={bookmark.id}
                    bookmark={bookmark}
                    attached={attached}
                    refreshing={refreshingId === bookmark.id}
                    onToggle={() => toggleSelection(bookmark.id)}
                    onRefresh={() => void handleRefresh(bookmark)}
                    onRemove={() => removeUrlBookmark(bookmark.id)}
                    removeTitle="Remove from workspace"
                  />
                )
              })}
            </ul>
          )}
        </div>
      </div>

      <AddBookmarkDialog
        open={addOpen !== null}
        onOpenChange={(o) => !o && setAddOpen(null)}
        onAdd={handleAdd}
      />
    </div>
  )
}

function AddBookmarkDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (url: string) => Promise<void>
}) {
  const [url, setUrl] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const close = () => {
    if (submitting) return
    setUrl("")
    onOpenChange(false)
  }

  const submit = async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      await onAdd(trimmed)
      setUrl("")
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm pt-32"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="w-full max-w-md mx-4 rounded-lg bg-[var(--background)] border border-[var(--border)] shadow-lg">
        <div className="px-4 py-3 border-b border-[var(--border)]">
          <h2 className="text-sm font-medium text-[var(--foreground)]">
            Add a workspace bookmark
          </h2>
          <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
            The server fetches the page, extracts text (up to 200 KB), and
            caches it. Private URLs and IP addresses are rejected.
          </p>
        </div>
        <div className="px-4 py-3 space-y-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !submitting) {
                e.preventDefault()
                void submit()
              }
              if (e.key === "Escape") close()
            }}
            placeholder="https://example.com/article"
            className="text-sm font-mono"
            autoFocus
            type="url"
          />
        </div>
        <div className="px-4 py-3 border-t border-[var(--border)] flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={submitting || !url.trim()}>
            {submitting ? "Fetching…" : "Save bookmark"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function BookmarkRow({
  bookmark,
  attached,
  refreshing,
  onToggle,
  onRefresh,
  onRemove,
  removeTitle,
}: {
  bookmark: UrlBookmark
  attached?: boolean
  refreshing: boolean
  onToggle?: () => void
  onRefresh: () => void
  onRemove: () => void
  removeTitle: string
}) {
  const interactive = typeof onToggle === "function"
  return (
    <li className="group/bookmark-row relative">
      <div
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={onToggle}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onToggle?.()
                }
              }
            : undefined
        }
        aria-pressed={interactive ? attached : undefined}
        title={bookmark.url}
        className={cn(
          // `pr-20` reserves room for the three hover-action buttons
          // (Eye / Refresh / Remove) so they don't overlap the title +
          // URL when revealed. Each button is ~20px wide; three plus
          // gaps + right offset is ~70px, so we use 80px for some
          // breathing room.
          "w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors pr-20",
          interactive
            ? attached
              ? "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/40 cursor-pointer"
              : "hover:bg-[var(--accent)] cursor-pointer"
            : "hover:bg-[var(--accent)]"
        )}
      >
        {interactive && (
          <span
            aria-hidden
            className={cn(
              "mt-0.5 shrink-0 size-4 rounded-[4px] border inline-flex items-center justify-center transition-colors text-[10px]",
              attached
                ? "bg-[var(--primary)] border-[var(--primary)] text-[var(--primary-foreground)]"
                : "border-[var(--border)] bg-transparent"
            )}
          >
            {attached && "✓"}
          </span>
        )}
        {bookmark.faviconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={bookmark.faviconUrl}
            alt=""
            className="mt-0.5 shrink-0 size-3.5 rounded-sm"
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).style.display = "none"
            }}
          />
        ) : (
          <Globe size={12} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
        )}
        <div className="flex-1 min-w-0">
          <div
            className={cn(
              "text-xs font-medium truncate",
              attached ? "text-[var(--primary)]" : "text-[var(--foreground)]"
            )}
          >
            {bookmark.title}
          </div>
          <div className="text-[10px] text-[var(--muted-foreground)] truncate flex items-center gap-1">
            <ExternalLink size={9} />
            <span className="truncate">{stripUrlScheme(bookmark.url)}</span>
          </div>
          <div
            className="text-[10px] text-[var(--muted-foreground)] mt-0.5"
            title={format(new Date(bookmark.fetchedAt), "MMM d, yyyy · h:mm a")}
          >
            Fetched {formatDistanceToNow(new Date(bookmark.fetchedAt), { addSuffix: true })}
            {bookmark.contentTruncated && " · truncated"}
          </div>
        </div>
      </div>
      <div
        className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover/bookmark-row:opacity-100 focus-within:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => openUrlPreview({ bookmarkId: bookmark.id })}
          aria-label={`Preview ${bookmark.title}`}
          title="Preview"
          className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors"
        >
          <Eye size={12} />
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={`Refresh ${bookmark.title}`}
          title="Re-fetch this URL"
          className={cn(
            "p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors",
            refreshing && "animate-spin"
          )}
        >
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${bookmark.title}`}
          title={removeTitle}
          className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)] transition-colors"
        >
          <X size={12} />
        </button>
      </div>
    </li>
  )
}

