"use client"

import { useRef } from "react"
import { Eye, Lock, Plus, X } from "lucide-react"
import { ALLOWED_EXTENSIONS } from "@/shared/upload-config"
import { formatFileSize, getFileIcon } from "@/client/file-utils"
import type { UploadedFile } from "@/shared/types"

/**
 * Conversation-private files section — sits above the workspace
 * `FilesTabBody` in the chat-mode resources panel. Files listed here
 * are scoped to one conversation and do **not** appear in the
 * workspace library. Upload goes through the chat input's `+` button
 * or this section's `+` button; removal calls `removeConversationFile`
 * which GCs the underlying `UploadedFile` when no other lane (no
 * `resources` row, no other `conversationFiles` row) still references
 * it.
 *
 * Kept intentionally compact — private lists tend to be small
 * (1-5 files) and don't need search.
 */
export function ConversationFilesSection({
  files,
  conversationId: _conversationId,
  onUpload,
  onRemove,
  onOpenPdf,
  onOpenImage,
}: {
  files: UploadedFile[]
  conversationId: string
  onUpload: (list: FileList | null) => void
  onRemove: (fileId: string) => void
  /** Same shape as `FilesTabBody.onOpenImage` — caller dispatches into
   *  the shared right-side image viewer with the file's metadata. */
  onOpenImage: (fileId: string) => void
  onOpenPdf: (fileId: string) => void
}) {
  void _conversationId
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="shrink-0 border-b border-[var(--border)]">
      <div className="h-11 px-3 flex items-center justify-between gap-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5 min-w-0">
          <Lock size={11} className="shrink-0 text-[var(--muted-foreground)]" />
          <p className="text-[11px] font-medium text-[var(--foreground)] truncate">
            This conversation
          </p>
          <span className="text-[10px] text-[var(--muted-foreground)] shrink-0">
            {files.length}
          </span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ALLOWED_EXTENSIONS.join(",")}
          className="hidden"
          onChange={(e) => {
            onUpload(e.target.files)
            if (fileInputRef.current) fileInputRef.current.value = ""
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach a file to this conversation"
          title="Attach a private file to this conversation"
          className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>
      {files.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]">
          No private files. Use the chat input&apos;s + button or this one to
          attach files only this conversation can see.
        </p>
      ) : (
        <ul className="px-2 py-1.5 space-y-0.5">
          {files.map((file) => {
            const isPdf =
              file.type === "application/pdf" ||
              file.name.toLowerCase().endsWith(".pdf")
            const isImage =
              file.extractedKind === "image" && !!file.imageDataUrl
            return (
              <li
                key={file.id}
                className="group/private-row relative flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--accent)] pr-14"
              >
                <span className="mt-0.5 shrink-0">{getFileIcon(file.type)}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate text-[var(--foreground)]">
                    {file.name}
                  </div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">
                    {formatFileSize(file.size)}
                  </div>
                </div>
                <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover/private-row:opacity-100 focus-within:opacity-100 transition-opacity">
                  {isPdf && (
                    <button
                      type="button"
                      onClick={() => onOpenPdf(file.id)}
                      aria-label={`Open "${file.name}" in PDF viewer`}
                      title="Open in PDF viewer"
                      className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors"
                    >
                      <Eye size={12} />
                    </button>
                  )}
                  {isImage && (
                    <button
                      type="button"
                      onClick={() => onOpenImage(file.id)}
                      aria-label={`Preview "${file.name}"`}
                      title="Preview image"
                      className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors"
                    >
                      <Eye size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(file.id)}
                    aria-label={`Remove ${file.name} from this conversation`}
                    title="Remove from this conversation"
                    className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)] transition-colors"
                  >
                    <X size={12} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
