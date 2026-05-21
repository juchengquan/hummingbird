"use client"

import { useCallback, useState } from "react"
import { format, formatDistanceToNow } from "date-fns"
import { ExternalLink, Globe, Lock, Plus, RefreshCw, X } from "lucide-react"
import { toast } from "sonner"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  useStore,
  useConversationPrivateUrlBookmarks,
  useConversationSelectedUrlBookmarkIds,
  useWorkspaceUrlBookmarks,
} from "@/client/hooks/use-store"
import { apiClient } from "@/client/api-client"
import { TabEmptyState } from "@/components/panels/tab-empty-state"
import { cn } from "@/shared/utils"
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
  const activeConversationId = useStore((s) => s.activeConversationId)
  const workspaceBookmarks = useWorkspaceUrlBookmarks()
  const privateBookmarks = useConversationPrivateUrlBookmarks()
  const selectedIds = useConversationSelectedUrlBookmarkIds()

  const addUrlBookmark = useStore((s) => s.addUrlBookmark)
  const updateUrlBookmark = useStore((s) => s.updateUrlBookmark)
  const removeUrlBookmark = useStore((s) => s.removeUrlBookmark)
  const addConversationUrlBookmark = useStore(
    (s) => s.addConversationUrlBookmark
  )
  const removeConversationUrlBookmark = useStore(
    (s) => s.removeConversationUrlBookmark
  )
  const toggleSelection = useStore(
    (s) => s.toggleConversationUrlBookmarkSelection
  )

  const [addOpen, setAddOpen] = useState<"workspace" | "conversation" | null>(
    null
  )
  const [refreshingId, setRefreshingId] = useState<string | null>(null)

  const handleAdd = useCallback(
    async (url: string, lane: "workspace" | "conversation") => {
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
      if (lane === "conversation" && activeConversationId) {
        addConversationUrlBookmark(activeConversationId, bookmark.id)
      } else if (lane === "workspace") {
        toggleSelection(bookmark.id)
      }
      const truncatedNote = result.bookmark.contentTruncated
        ? " (truncated at 200 KB)"
        : ""
      toast.success(`Saved "${bookmark.title}"`, {
        description: `${result.bookmark.content.length.toLocaleString()} chars${truncatedNote}`,
      })
      setAddOpen(null)
    },
    [
      activeConversationId,
      activeWorkspaceId,
      addConversationUrlBookmark,
      addUrlBookmark,
      toggleSelection,
    ]
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
      {/* This conversation — private pinned bookmarks. */}
      {activeConversationId && (
        <UrlBookmarkSection
          title="This conversation"
          icon={Lock}
          bookmarks={privateBookmarks}
          emptyHint="No bookmarks pinned. Use + to attach a URL only this conversation can see."
          addLabel="Pin a URL to this conversation"
          onAdd={() => setAddOpen("conversation")}
          refreshingId={refreshingId}
          onRefresh={handleRefresh}
          rowAction={{
            kind: "remove",
            onClick: (bookmark) =>
              removeConversationUrlBookmark(activeConversationId, bookmark.id),
          }}
        />
      )}

      {/* Workspace bookmarks — tickable rows. */}
      <div className="flex-1 min-h-0 flex flex-col border-t border-[var(--border)]">
        <div className="shrink-0 h-11 px-3 flex items-center justify-between gap-2 border-b border-[var(--border)]">
          <div className="flex items-center gap-1.5 min-w-0">
            <Globe size={11} className="shrink-0 text-[var(--muted-foreground)]" />
            <p className="text-[11px] font-medium text-[var(--foreground)] truncate">
              Workspace bookmarks
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
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
          {workspaceBookmarks.length === 0 ? (
            <TabEmptyState icon={Globe} onClick={() => setAddOpen("workspace")}>
              No bookmarks yet. Add a URL to save it as workspace context.
            </TabEmptyState>
          ) : (
            <ul className="space-y-0.5">
              {workspaceBookmarks.map((bookmark) => {
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
        lane={addOpen}
        onOpenChange={(o) => !o && setAddOpen(null)}
        onAdd={handleAdd}
      />
    </div>
  )
}

function UrlBookmarkSection({
  title,
  icon: Icon,
  bookmarks,
  emptyHint,
  addLabel,
  onAdd,
  refreshingId,
  onRefresh,
  rowAction,
}: {
  title: string
  icon: typeof Lock
  bookmarks: UrlBookmark[]
  emptyHint: string
  addLabel: string
  onAdd: () => void
  refreshingId: string | null
  onRefresh: (bookmark: UrlBookmark) => Promise<void>
  rowAction: { kind: "remove"; onClick: (bookmark: UrlBookmark) => void }
}) {
  return (
    <div className="shrink-0 border-b border-[var(--border)]">
      <div className="h-11 px-3 flex items-center justify-between gap-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon size={11} className="shrink-0 text-[var(--muted-foreground)]" />
          <p className="text-[11px] font-medium text-[var(--foreground)] truncate">
            {title}
          </p>
          <span className="text-[10px] text-[var(--muted-foreground)] shrink-0">
            {bookmarks.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onAdd}
          aria-label={addLabel}
          title={addLabel}
          className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>
      {bookmarks.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]">
          {emptyHint}
        </p>
      ) : (
        <ul className="px-2 py-1.5 space-y-0.5">
          {bookmarks.map((bookmark) => (
            <BookmarkRow
              key={bookmark.id}
              bookmark={bookmark}
              refreshing={refreshingId === bookmark.id}
              onRefresh={() => void onRefresh(bookmark)}
              onRemove={() => rowAction.onClick(bookmark)}
              removeTitle="Remove from this conversation"
            />
          ))}
        </ul>
      )}
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
          "w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors pr-14",
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
            <span className="truncate">{stripScheme(bookmark.url)}</span>
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

function AddBookmarkDialog({
  open,
  lane,
  onOpenChange,
  onAdd,
}: {
  open: boolean
  lane: "workspace" | "conversation" | null
  onOpenChange: (open: boolean) => void
  onAdd: (url: string, lane: "workspace" | "conversation") => Promise<void>
}) {
  const [url, setUrl] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const close = () => {
    if (submitting) return
    setUrl("")
    onOpenChange(false)
  }

  const submit = async () => {
    if (!lane) return
    const trimmed = url.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      await onAdd(trimmed, lane)
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
            {lane === "conversation" ? "Pin a URL to this conversation" : "Add a workspace bookmark"}
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

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "")
}
