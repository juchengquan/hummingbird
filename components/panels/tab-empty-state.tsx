"use client"

import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface TabEmptyStateProps {
  icon: LucideIcon
  children: React.ReactNode
  /** When set, the empty state renders as a button. Used by the Files
   *  tab where clicking "Upload files…" opens the picker; the Notes
   *  and Artifacts tabs leave this unset because their "create" entry
   *  point lives elsewhere (a "+" button in the tab's own header). */
  onClick?: () => void
  className?: string
}

/**
 * Shared placeholder for the right-sidebar tabs (Files / Notes /
 * Artifacts) when the underlying list is empty. Dashed-border box with
 * a centered icon + short copy. Optionally clickable.
 *
 * Three tabs each had their own copy of this; this component is
 * purely a layout shell so future tabs (Skills, future Memory, etc.)
 * pick up the same look automatically.
 */
export function TabEmptyState({
  icon: Icon,
  children,
  onClick,
  className,
}: TabEmptyStateProps) {
  const base = cn(
    "h-full min-h-[120px] flex flex-col items-center justify-center gap-2 px-3 text-center text-xs italic rounded-md border border-dashed border-[var(--border)] text-[var(--muted-foreground)]",
    onClick &&
      "transition-colors hover:border-[var(--primary)] hover:text-[var(--foreground)]",
    className
  )

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(base, "w-full")}>
        <Icon size={20} />
        <span>{children}</span>
      </button>
    )
  }
  return (
    <div className={base}>
      <Icon size={20} />
      <span>{children}</span>
    </div>
  )
}
