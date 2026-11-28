"use client"

/**
 * Shared header for right-drawer preview surfaces (PDF, image, DOCX,
 * text, CSV, …). Unifies the visual rhythm so a user opening any
 * preview always sees:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Title (truncated)                            │
 *   │ <size> · <TYPE> · Updated <relative>         │
 *   │                                              │
 *   │ [viewer-specific controls]    [⬇ 📋 ↗]      │
 *   └──────────────────────────────────────────────┘
 *
 * The right-cluster (download / copy URL / open in new tab) is built
 * into the header so we don't repeat it per viewer. The middle slot
 * (`controls`) is for viewer-specific affordances — page nav + zoom in
 * the PDF case, refresh in the DOCX case, prev/next + zoom in the
 * image case.
 *
 * Designed to drop into a Radix `<SheetHeader>` directly (it provides
 * its own `SheetTitle` via the `title` prop's `<h2>` element wrapped by
 * the caller's `SheetTitle`). To keep the header structurally simple
 * we render plain elements here; the consumer wraps in `<SheetHeader>`
 * + `<SheetTitle>` for a11y semantics. See PdfViewer for the canonical
 * adoption shape.
 */

import { Copy, Download, ExternalLink } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { toast } from "sonner"
import { type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn, formatBytes } from "@/shared/utils"

export interface PreviewHeaderAction {
  /** Lucide icon component, rendered at size 13. */
  icon: React.ComponentType<{ size?: number; className?: string }>
  /** Aria-label + tooltip text. Visible only on hover/focus. */
  label: string
  /** Click handler. Async actions should manage their own loading state
   *  via the icon prop if needed (e.g. spinning RefreshCw). */
  onClick: () => void
  /** Disable the button. */
  disabled?: boolean
  /** Optional className applied to the icon (e.g. for animation states
   *  like a spinning refresh icon). */
  iconClassName?: string
}

export interface PreviewHeaderProps {
  /** Filename or other primary identifier. Truncates with ellipsis. */
  title: string
  /** Optional file-size in bytes — formatted into the subline. */
  sizeBytes?: number
  /** Optional type label — usually the uppercased extension ("PDF",
   *  "DOCX", "PNG", "CSV"). When omitted, no type segment shows. */
  typeLabel?: string
  /** Optional "updated at" timestamp — rendered as "Updated 2 hours
   *  ago" with a tooltip showing the absolute date. */
  updatedAt?: Date | string | null
  /** Viewer-specific controls between the title block and the actions
   *  cluster. E.g. PDF page nav + zoom, image prev/next, etc. */
  controls?: ReactNode
  /** Standard right-cluster action buttons (rendered after `controls`).
   *  Already wires tooltips + icon styling — pass shape only. */
  actions?: PreviewHeaderAction[]
  /** Optional URL — when present, adds a "Copy URL" button to the
   *  actions cluster automatically. The caller doesn't need to wire it
   *  per viewer; same toast on success. */
  copyUrl?: string
  className?: string
}

export function PreviewHeader({
  title,
  sizeBytes,
  typeLabel,
  updatedAt,
  controls,
  actions = [],
  copyUrl,
  className,
}: PreviewHeaderProps) {
  // Build the subline from whichever bits the caller provided. We avoid
  // rendering empty `·` separators by joining a filtered array.
  const sublineParts: ReactNode[] = []
  if (typeof sizeBytes === "number" && sizeBytes > 0) {
    sublineParts.push(<span key="size">{formatBytes(sizeBytes)}</span>)
  }
  if (typeLabel) {
    sublineParts.push(
      <span key="type" className="uppercase tracking-wide">
        {typeLabel}
      </span>
    )
  }
  if (updatedAt) {
    const date = new Date(updatedAt)
    sublineParts.push(
      <span
        key="updated"
        title={date.toLocaleString()}
        className="whitespace-nowrap"
      >
        Updated {formatDistanceToNow(date, { addSuffix: true })}
      </span>
    )
  }

  // Inject the auto Copy URL action when a `copyUrl` is provided.
  const fullActions: PreviewHeaderAction[] = copyUrl
    ? [
        ...actions,
        {
          icon: Copy,
          label: "Copy URL",
          onClick: () => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(copyUrl)
                toast.success(
                  copyUrl.startsWith("data:") ? "Data URL copied" : "URL copied"
                )
              } catch {
                toast.error("Copy failed")
              }
            })()
          },
        },
      ]
    : actions

  const hasToolbar =
    sublineParts.length > 0 || !!controls || fullActions.length > 0

  return (
    <div className={cn("space-y-1.5", className)}>
      {/* Row 1: title only. Subline + toolbar share the next row. */}
      <p
        className="text-sm font-medium truncate text-[var(--foreground)]"
        title={title}
      >
        {title}
      </p>

      {/* Row 2: subline on the left, viewer-specific controls + standard
          actions right-aligned. One row packs info and buttons together
          so the header doesn't waste a separate line per concern. The
          subline is `min-w-0` + `truncate` so on narrow widths it
          shrinks first and the buttons stay legible. */}
      {hasToolbar && (
        <div className="flex items-center gap-2">
          {sublineParts.length > 0 ? (
            <p className="flex-1 min-w-0 text-[10px] text-[var(--muted-foreground)] truncate">
              {sublineParts.map((part, idx) => (
                <span key={idx}>
                  {idx > 0 && <span className="opacity-50"> · </span>}
                  {part}
                </span>
              ))}
            </p>
          ) : (
            // Spacer so the toolbar still pushes right when there's no
            // subline (e.g. an "unavailable" empty state).
            <span className="flex-1" />
          )}
          {controls && (
            <div className="flex items-center gap-1 shrink-0">{controls}</div>
          )}
          {fullActions.length > 0 && (
            <div className="flex items-center gap-0.5 shrink-0">
              {fullActions.map((action, idx) => (
                <Tooltip key={`${action.label}-${idx}`}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={action.disabled}
                      onClick={action.onClick}
                      aria-label={action.label}
                      className="h-7 w-7 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    >
                      <action.icon
                        size={13}
                        className={action.iconClassName}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    {action.label}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Re-export the action shape so consumers can build typed action arrays. */
export type { PreviewHeaderAction as PreviewAction }
export { Download, ExternalLink }
