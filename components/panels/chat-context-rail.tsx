"use client"

import { useCallback, useRef, useState } from "react"
import { Plus, Upload } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  useStore,
  useSessionStore,
  useWorkspaceResources,
} from "@/lib/hooks/use-store"
import { getFileIcon, processSelectedFiles, formatFileSize } from "@/lib/file-utils"

const FILE_SIZE_LIMIT = 5 * 1024 * 1024 // 5MB
const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".csv", ".json", ".png", ".jpg", ".jpeg"]

export function ChatContextRail() {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const addFile = useStore((s) => s.addFile)
  const addResource = useStore((s) => s.addResource)
  const setActiveView = useStore((s) => s.setActiveView)
  const { selectedFileIds, toggleFileSelection } = useSessionStore()
  const resources = useWorkspaceResources()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  const handleUpload = useCallback(
    (list: FileList | null) => {
      setError(null)
      const newFiles = processSelectedFiles(list, {
        maxSize: FILE_SIZE_LIMIT,
        onValidationError: setError,
      })
      newFiles.forEach((file) => {
        addFile(file)
        addResource(activeWorkspaceId, file.id)
        toggleFileSelection(file.id)
      })
    },
    [addFile, addResource, activeWorkspaceId, toggleFileSelection]
  )

  const openPicker = () => fileInputRef.current?.click()

  return (
    <div
      aria-label="Workspace files"
      className="shrink-0 border-b border-[var(--border)] bg-[var(--background)]/60 backdrop-blur-sm"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        {resources.length === 0 ? (
          <button
            type="button"
            onClick={openPicker}
            className="flex-1 text-left text-xs italic text-[var(--muted-foreground)] px-2 py-1.5 rounded-md border border-dashed border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--foreground)] transition-colors"
          >
            <Upload size={12} className="inline mr-1.5" />
            Upload files to add workspace context
          </button>
        ) : (
          <div
            className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto scrollbar-none"
            style={{
              maskImage:
                "linear-gradient(to right, black 0%, black 92%, transparent 100%)",
              WebkitMaskImage:
                "linear-gradient(to right, black 0%, black 92%, transparent 100%)",
            }}
          >
            {resources.map((file) => {
              const attached = selectedFileIds.includes(file.id)
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => toggleFileSelection(file.id)}
                  aria-pressed={attached}
                  title={`${file.name} · ${formatFileSize(file.size)}`}
                  className={cn(
                    "shrink-0 h-7 px-2.5 rounded-md text-xs gap-1.5 inline-flex items-center transition-colors",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                    attached
                      ? "ring-1 ring-[var(--primary)]/50 bg-[var(--primary)]/10 text-[var(--primary)]"
                      : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                  )}
                >
                  {getFileIcon(file.type)}
                  <span className="truncate max-w-[16ch]">{file.name}</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="flex items-center gap-1 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_EXTENSIONS.join(",")}
            className="hidden"
            onChange={(e) => {
              handleUpload(e.target.files)
              if (fileInputRef.current) fileInputRef.current.value = ""
            }}
          />
          <button
            type="button"
            onClick={openPicker}
            aria-label="Upload files to workspace"
            title="Upload files"
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            onClick={() => setActiveView("resources")}
            className="h-7 px-2 text-[11px] rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors"
          >
            Manage
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3 pb-1.5 text-[11px] text-red-500" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
