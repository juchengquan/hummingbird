"use client"

import { useState } from "react"
import { FileText, Trash2, X, ImageOff } from "lucide-react"
import { useStore } from "@/client/hooks/use-store"
import { getFileIcon, formatFileSize } from "@/client/file-utils"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/shared/utils"
import type { UploadedFile } from "@/shared/types"

/**
 * Renders attached-file chips / image thumbnails for a single message.
 * Lives below the message content. Clicking an image opens a full-size
 * preview dialog; non-image chips show metadata in their tooltip.
 *
 * Three rendering states per id:
 *   - file present and live → full chip / image thumb (interactive)
 *   - file present but tombstoned (`deletedAt` set) → muted chip
 *     showing the original name so users know *what* was attached
 *   - file fully missing from `files[]` (legacy hard-deletes, or
 *     hand-edited storage) → generic "deleted attachment" placeholder
 */
export function MessageAttachments({
  fileIds,
  align,
}: {
  fileIds: string[]
  /** Match the message's flex direction so chips line up under the bubble. */
  align: "start" | "end"
}) {
  const files = useStore((s) => s.files)
  const [previewFile, setPreviewFile] = useState<UploadedFile | null>(null)

  if (fileIds.length === 0) return null

  return (
    <>
      <div
        className={cn(
          "flex flex-wrap gap-1.5 mt-2",
          align === "end" ? "justify-end" : "justify-start"
        )}
      >
        {fileIds.map((id) => {
          const file = files.find((f) => f.id === id)
          if (!file) {
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-dashed border-[var(--border)] text-[10px] text-[var(--muted-foreground)]"
                title="This attachment has been deleted from the workspace."
              >
                <ImageOff size={10} />
                Deleted attachment
              </span>
            )
          }

          if (file.deletedAt) {
            // Tombstoned: metadata stub remains but content is freed.
            // Show the original name so users can see *what* was sent
            // even though the file is gone.
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 max-w-[200px] px-2 py-1 rounded-md border border-dashed border-[var(--border)] text-[11px] text-[var(--muted-foreground)] italic"
                title={`${file.name} · removed`}
              >
                <Trash2 size={10} className="shrink-0" />
                <span className="truncate">{file.name}</span>
              </span>
            )
          }

          const isImage = file.extractedKind === "image" && file.imageDataUrl
          if (isImage) {
            return (
              <button
                key={id}
                type="button"
                onClick={() => setPreviewFile(file)}
                className="group/thumb relative rounded-md overflow-hidden border border-[var(--border)] hover:border-[var(--ring)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                title={`${file.name} · ${formatFileSize(file.size)}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={file.imageDataUrl}
                  alt={file.name}
                  className="block w-14 h-14 object-cover"
                />
              </button>
            )
          }

          return (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 max-w-[200px] px-2 py-1 rounded-md border border-[var(--border)] bg-[var(--background)]/60 text-[11px] text-[var(--foreground)]"
              title={`${file.name} · ${formatFileSize(file.size)}`}
            >
              <span className="shrink-0">
                {getFileIcon(file.type) ?? <FileText size={12} />}
              </span>
              <span className="truncate">{file.name}</span>
            </span>
          )
        })}
      </div>

      <Dialog
        open={previewFile !== null}
        onOpenChange={(v) => {
          if (!v) setPreviewFile(null)
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[85vh] p-0 overflow-hidden">
          <DialogHeader className="px-4 py-2 border-b border-[var(--border)]">
            <DialogTitle className="text-sm truncate">
              {previewFile?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center bg-[var(--secondary)]/30 overflow-auto">
            {previewFile?.imageDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewFile.imageDataUrl}
                alt={previewFile.name}
                className="max-w-full max-h-[70vh] object-contain"
              />
            ) : (
              <div className="p-8 text-sm text-[var(--muted-foreground)] flex items-center gap-2">
                <X size={14} />
                Image data is unavailable.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
