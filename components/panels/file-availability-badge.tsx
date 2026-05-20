"use client"

import { LaptopMinimal } from "lucide-react"
import type { UploadedFile } from "@/shared/types"
import { useFileAvailability } from "@/client/files/use-file-availability"
import { cn } from "@/shared/utils"

interface FileAvailabilityBadgeProps {
  file: UploadedFile
  className?: string
}

/**
 * Renders "On another device" next to a file row when the raw blob isn't
 * reachable from this browser — i.e. the file has no `storagePath` (so it
 * was uploaded under local-files mode) and isn't in this browser's
 * IndexedDB cache.
 *
 * Returns null in every other case. Extracted text + metadata still work
 * across devices regardless; this badge is purely about whether you can
 * re-open / re-extract / preview the original blob from here.
 */
export function FileAvailabilityBadge({ file, className }: FileAvailabilityBadgeProps) {
  const available = useFileAvailability(file)
  if (available !== false) return null
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] text-[var(--muted-foreground)]",
        className
      )}
      title="The raw file is stored on another device. Extracted text still works, but preview and re-extraction are unavailable here."
    >
      <LaptopMinimal size={10} />
      On another device
    </span>
  )
}
