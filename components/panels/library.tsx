"use client"

import "client-only"

import * as React from "react"
import { ArrowUpRight, Image as ImageIcon, MessageSquare, Package } from "lucide-react"

import { useStore } from "@/client/hooks/use-store"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { openImageViewer } from "@/components/right-panel-slot"
import type { ImageViewerItem } from "@/components/image-viewer/types"
import {
  collectWorkspaceLibraryItems,
  type LibraryItem,
  type ImageItem,
  type ArtifactItem,
} from "@/shared/library/collect"
import { cn } from "@/shared/utils"

/**
 * Library panel — a cross-conversation index of every generated image +
 * artifact in the active workspace. Item #5 from
 * `docs/PLAN-cross-product-inspirations.md` ("promote
 * `message_generated_images` + generated artifacts to first-class
 * addressable rows").
 *
 * Read-only: every row joins the existing
 * `Message.generatedImages` + `Artifact` data already in the store. No
 * new store slice, no new migration. The clickable affordance on each
 * row is "jump to source conversation" — `setActiveConversation` +
 * `setActiveView("chat")`. Image rows additionally open the lightbox
 * viewer.
 *
 * Out of scope for v1 (deliberately): search across rows, filter by
 * date or kind, multi-select bulk delete, drag-onto-canvas. The point
 * is discoverability; surface area expands only if usage justifies it.
 */

const EMPTY_ITEMS: readonly LibraryItem[] = Object.freeze([])

/** Selector for the active workspace's library. Subscribes to the raw
 *  inputs (workspaceId + conversations + artifacts) — all reference-
 *  stable in the Zustand store — and memoises the join in React.
 *
 *  Why not `useShallow` around `collectWorkspaceLibraryItems`: the helper
 *  constructs fresh wrapper objects (`{kind, image, timestamp: new
 *  Date(...), ...}`) on every call. `useShallow` does element-wise
 *  `Object.is`, so two successive calls always look "changed" — React's
 *  `useSyncExternalStore` then sees an unstable snapshot and loops
 *  ("result of getSnapshot should be cached"). Memoising on the
 *  reference-stable inputs sidesteps that. */
function useWorkspaceLibrary(): readonly LibraryItem[] {
  const wsId = useStore((s) => s.activeWorkspaceId)
  const conversations = useStore((s) => s.conversations)
  const artifacts = useStore((s) => s.artifacts)
  return React.useMemo(() => {
    if (!wsId) return EMPTY_ITEMS
    const items = collectWorkspaceLibraryItems(wsId, conversations, artifacts)
    return items.length === 0 ? EMPTY_ITEMS : items
  }, [wsId, conversations, artifacts])
}

export function LibraryPanel() {
  const items = useWorkspaceLibrary()
  const setActiveConversation = useStore((s) => s.setActiveConversation)
  const setActiveView = useStore((s) => s.setActiveView)
  const activeWorkspace = useStore((s) =>
    s.activeWorkspaceId
      ? s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null
      : null,
  )

  const images = React.useMemo(
    () => items.filter((i): i is ImageItem => i.kind === "image"),
    [items],
  )
  const artifacts = React.useMemo(
    () => items.filter((i): i is ArtifactItem => i.kind === "artifact"),
    [items],
  )

  const handleOpenConversation = React.useCallback(
    (id: string) => {
      setActiveConversation(id)
      setActiveView("chat")
    },
    [setActiveConversation, setActiveView],
  )

  const handleOpenImage = React.useCallback(
    (clicked: ImageItem) => {
      // Build a viewer carousel from EVERY library image (not just the
      // clicked one) so prev / next browses the whole library, in the
      // newest-first order the list already shows.
      const viewerImages: ImageViewerItem[] = images.map((it) => ({
        id: it.image.id,
        url: it.image.url,
        alt: it.image.prompt || "Generated image",
        format: it.image.format,
        prompt: it.image.prompt,
        mode: it.image.mode,
      }))
      const initialIndex = images.findIndex(
        (it) =>
          it.image.id === clicked.image.id && it.messageId === clicked.messageId,
      )
      openImageViewer({
        images: viewerImages,
        initialIndex: initialIndex >= 0 ? initialIndex : 0,
      })
    },
    [images],
  )

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <Package size={16} className="text-[var(--muted-foreground)]" />
        <h1 className="text-sm font-medium">
          Library
          {activeWorkspace ? (
            <span className="text-[var(--muted-foreground)] font-normal">
              {" "}
              · {activeWorkspace.name}
            </span>
          ) : null}
        </h1>
        <div className="ml-auto text-xs text-[var(--muted-foreground)]">
          {images.length} image{images.length === 1 ? "" : "s"}
          {" · "}
          {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}
        </div>
      </header>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-8">
          {items.length === 0 ? (
            <EmptyState hasWorkspace={!!activeWorkspace} />
          ) : (
            <>
              {images.length > 0 ? (
                <section>
                  <h2 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                    <ImageIcon size={12} />
                    Generated images
                  </h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
                    {images.map((it) => (
                      <ImageTile
                        key={`${it.messageId}:${it.image.id}`}
                        item={it}
                        onOpenImage={() => handleOpenImage(it)}
                        onOpenConversation={() =>
                          handleOpenConversation(it.conversationId)
                        }
                      />
                    ))}
                  </div>
                </section>
              ) : null}

              {artifacts.length > 0 ? (
                <section>
                  <h2 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                    <Package size={12} />
                    Artifacts
                  </h2>
                  <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                    {artifacts.map((it) => (
                      <ArtifactRow
                        key={it.artifact.id}
                        item={it}
                        onOpenConversation={
                          // Artifacts outlive their source conversation —
                          // when the source has been deleted, leave the
                          // row visible but inert. ArtifactRow renders
                          // `null` for `onOpenConversation` as a static
                          // row instead of a button.
                          it.artifact.conversationId
                            ? () => handleOpenConversation(it.artifact.conversationId!)
                            : null
                        }
                      />
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function ImageTile({
  item,
  onOpenImage,
  onOpenConversation,
}: {
  item: ImageItem
  onOpenImage: () => void
  onOpenConversation: () => void
}) {
  return (
    <div className="group relative flex flex-col rounded-md border border-[var(--border)] bg-[var(--card)] overflow-hidden">
      <button
        type="button"
        onClick={onOpenImage}
        className={cn(
          "block w-full aspect-square bg-[var(--muted)]",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        )}
        aria-label={`Open image — ${item.image.prompt || "generated"}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.image.url}
          alt={item.image.prompt || "Generated image"}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      </button>
      <div className="p-2 space-y-1.5">
        <p
          className="line-clamp-2 text-xs text-[var(--foreground)]"
          title={item.image.prompt}
        >
          {item.image.prompt || <em className="text-[var(--muted-foreground)]">No prompt</em>}
        </p>
        <button
          type="button"
          onClick={onOpenConversation}
          className="flex w-full items-center gap-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          title={`Open conversation: ${item.conversationTitle}`}
        >
          <MessageSquare size={10} className="shrink-0" />
          <span className="truncate">{item.conversationTitle}</span>
          <ArrowUpRight size={10} className="shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
      </div>
    </div>
  )
}

function ArtifactRow({
  item,
  onOpenConversation,
}: {
  item: ArtifactItem
  /** Null when the source conversation has been deleted — render the
   *  row as a static row (no jump target) instead of a button. */
  onOpenConversation: (() => void) | null
}) {
  const meta = (
    <>
      {item.artifact.kind}
      {item.artifact.language ? ` · ${item.artifact.language}` : ""}
      {" · "}
      {onOpenConversation
        ? item.conversationTitle
        : `${item.conversationTitle} (conversation removed)`}
    </>
  )
  if (!onOpenConversation) {
    return (
      <li className="flex items-center gap-3 px-3 py-2 opacity-70">
        <Package size={14} className="shrink-0 text-[var(--muted-foreground)]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{item.artifact.title}</p>
          <p className="truncate text-xs text-[var(--muted-foreground)]">{meta}</p>
        </div>
      </li>
    )
  }
  return (
    <li>
      <button
        type="button"
        onClick={onOpenConversation}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--accent)] focus:outline-none focus-visible:bg-[var(--accent)]"
      >
        <Package size={14} className="shrink-0 text-[var(--muted-foreground)]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{item.artifact.title}</p>
          <p className="truncate text-xs text-[var(--muted-foreground)]">{meta}</p>
        </div>
        <ArrowUpRight size={14} className="shrink-0 text-[var(--muted-foreground)]" />
      </button>
    </li>
  )
}

function EmptyState({ hasWorkspace }: { hasWorkspace: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-sm text-[var(--muted-foreground)]">
      <Package size={32} className="opacity-40" />
      {hasWorkspace ? (
        <>
          <p>No generated images or artifacts yet.</p>
          <p className="text-xs">
            Generated images and saved artifacts from this workspace show up here.
          </p>
        </>
      ) : (
        <p>Pick a workspace to browse its library.</p>
      )}
    </div>
  )
}
