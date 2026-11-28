"use client"

import { useState } from "react"
import { RotateCcw } from "lucide-react"
import type { UploadedFile } from "@/shared/types"
import { useStore } from "@/client/hooks/use-store"
import { useFileAvailability } from "@/client/files/use-file-availability"
import { fetchFileBlob } from "@/client/files/fetch-blob"
import { retryExtraction } from "@/client/extract"
import { ExtractionStatusBadge } from "@/components/panels/extraction-status-badge"
import { FileAvailabilityBadge } from "@/components/panels/file-availability-badge"
import { cn } from "@/shared/utils"
import { toast } from "sonner"

interface FileRowMetaProps {
  file: UploadedFile
  /** Layout flavor — "compact" is for the right sidebar, "default" is for sources.tsx. */
  size?: "compact" | "default"
  className?: string
}

/**
 * Composite row trailing for an uploaded file: extraction badge +
 * cross-device availability badge + a small Re-extract button when
 * extraction failed, was unsupported, or is missing on a legacy row AND
 * the blob is reachable from this device.
 *
 * Centralises the availability check so the badges and the retry gate
 * see the same answer without firing two IndexedDB lookups.
 */
export function FileRowMeta({ file, size = "compact", className }: FileRowMetaProps) {
  const available = useFileAvailability(file)
  const setFileExtraction = useStore((s) => s.setFileExtraction)
  const [retrying, setRetrying] = useState(false)

  const status = file.extractionStatus
  const retryable =
    status === "failed" || status === "unsupported" || status === undefined

  const handleRetry = async (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (retrying) return
    setRetrying(true)
    try {
      const blob = await fetchFileBlob(file)
      if (!blob) {
        toast.error(`Couldn't reach "${file.name}" — blob unavailable.`)
        return
      }
      await retryExtraction(file, blob, setFileExtraction)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className={cn("inline-flex items-center gap-1.5 flex-wrap", className)}>
      <ExtractionStatusBadge file={file} size={size} />
      {available === false && <FileAvailabilityBadge file={file} />}
      {retryable && available !== false && (
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          aria-label={`Re-extract "${file.name}"`}
          title="Re-run text extraction. Useful when a previous attempt failed or after new format support shipped."
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px]",
            "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]",
            "transition-colors disabled:opacity-50 disabled:cursor-wait"
          )}
        >
          <RotateCcw size={10} className={cn(retrying && "animate-spin")} />
          {retrying ? "Re-extracting…" : "Re-extract"}
        </button>
      )}
    </div>
  )
}
