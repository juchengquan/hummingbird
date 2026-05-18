"use client"

import { Loader2, AlertCircle, FileQuestion, Scissors } from "lucide-react"
import { cn } from "@/lib/utils"
import type { UploadedFile } from "@/lib/types"

interface ExtractionStatusBadgeProps {
  file: UploadedFile
  /** Slightly larger pill, used by the resources panel. Default: inline-compact. */
  size?: "compact" | "default"
  className?: string
}

/**
 * Small per-file indicator showing the lifecycle of the /api/extract call.
 *
 * - `pending` → spinner, "Extracting…"
 * - `done` (default state) → no badge unless content was truncated
 * - `unsupported` → muted "No text" label
 * - `failed` → destructive "Failed" label with a tooltip
 *
 * Truncated content gets a small scissors icon regardless of status so the
 * user knows the AI may be missing the tail of the file.
 */
export function ExtractionStatusBadge({
  file,
  size = "compact",
  className,
}: ExtractionStatusBadgeProps) {
  const status = file.extractionStatus
  const truncated = !!file.extractionTruncated

  const base =
    size === "compact"
      ? "inline-flex items-center gap-1 text-[10px]"
      : "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"

  if (status === "pending") {
    return (
      <span
        className={cn(base, "text-[var(--muted-foreground)]", className)}
        title="Extracting text content for AI context…"
      >
        <Loader2 size={size === "compact" ? 10 : 12} className="animate-spin" />
        Extracting…
      </span>
    )
  }

  if (status === "failed") {
    return (
      <span
        className={cn(
          base,
          "text-[var(--destructive)]",
          size === "default" && "bg-[var(--destructive)]/10",
          className
        )}
        title="Text extraction failed for this file — the model will only see metadata."
      >
        <AlertCircle size={size === "compact" ? 10 : 12} />
        Extraction failed
      </span>
    )
  }

  if (status === "unsupported") {
    return (
      <span
        className={cn(base, "text-[var(--muted-foreground)]", className)}
        title="This file type isn't text-extractable yet — the model will only see metadata."
      >
        <FileQuestion size={size === "compact" ? 10 : 12} />
        No text
      </span>
    )
  }

  // `done` or undefined (legacy files / non-extracted demos)
  if (truncated) {
    return (
      <span
        className={cn(base, "text-amber-600 dark:text-amber-500", className)}
        title="Extracted text was truncated to fit the per-file budget."
      >
        <Scissors size={size === "compact" ? 10 : 12} />
        Truncated
      </span>
    )
  }

  return null
}
