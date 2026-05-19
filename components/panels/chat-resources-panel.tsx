"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { format } from "date-fns"
import { Search, Plus, FolderOpen, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import {
  useStore,
  useWorkspaceResources,
  useConversationSelectedFileIds,
} from "@/lib/hooks/use-store"
import { getFileIcon, processSelectedFiles, formatFileSize } from "@/lib/file-utils"
import { FILE_SIZE_LIMIT, IMAGE_SIZE_LIMIT, ALLOWED_EXTENSIONS } from "@/lib/upload-config"
import { runExtraction } from "@/lib/extract"
import { persistFile } from "@/lib/files/persist"
import { NotesTab } from "@/components/panels/notes-tab"
import { ArtifactsTab } from "@/components/panels/artifacts-tab"
import { ExtractionStatusBadge } from "@/components/panels/extraction-status-badge"
import { FileAvailabilityBadge } from "@/components/panels/file-availability-badge"

export function ChatResourcesPanel() {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const addFile = useStore((s) => s.addFile)
  const addResource = useStore((s) => s.addResource)
  const setFileExtraction = useStore((s) => s.setFileExtraction)
  const setFileStorage = useStore((s) => s.setFileStorage)
  const setActiveView = useStore((s) => s.setActiveView)
  const toggleFileSelection = useStore((s) => s.toggleConversationFileSelection)
  const selectedFileIds = useConversationSelectedFileIds()
  const resources = useWorkspaceResources()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const tab = useStore((s) => s.resourcesSidebarTab)

  // mount flag for date formatting (avoid SSR mismatch)
  if (!mounted && typeof window !== "undefined") {
    queueMicrotask(() => setMounted(true))
  }

  const filtered = useMemo(() => {
    if (!query.trim()) return resources
    const q = query.toLowerCase()
    return resources.filter((f) => f.name.toLowerCase().includes(q))
  }, [resources, query])

  const attachedCount = useMemo(
    () => resources.filter((f) => selectedFileIds.includes(f.id)).length,
    [resources, selectedFileIds]
  )

  const handleUpload = useCallback(
    (list: FileList | null) => {
      setError(null)
      const processed = processSelectedFiles(list, {
        maxSize: FILE_SIZE_LIMIT,
        maxImageSize: IMAGE_SIZE_LIMIT,
        onValidationError: setError,
      })
      processed.forEach(({ meta, source }) => {
        addFile(meta)
        addResource(activeWorkspaceId, meta.id)
        toggleFileSelection(meta.id)
        void runExtraction(meta.id, source, setFileExtraction)
        void persistFile(source, meta.id, meta.name).then((result) => {
          if (result.storagePath) {
            setFileStorage(meta.id, { storagePath: result.storagePath })
          }
        })
      })
    },
    [addFile, addResource, activeWorkspaceId, toggleFileSelection, setFileExtraction, setFileStorage]
  )

  return (
    <div className="flex flex-col w-full h-full min-h-0">
      {/* Tab strip removed — the icon column in <ResourcesSidebar/> is the
          tab switcher now. Just render the active tab's body. */}
      {tab === "notes" ? (
        <NotesTab />
      ) : tab === "artifacts" ? (
        <ArtifactsTab />
      ) : (
        <FilesTabBody
          resources={resources}
          attachedCount={attachedCount}
          query={query}
          setQuery={setQuery}
          filtered={filtered}
          selectedFileIds={selectedFileIds}
          toggleFileSelection={toggleFileSelection}
          mounted={mounted}
          error={error}
          fileInputRef={fileInputRef}
          handleUpload={handleUpload}
          setActiveView={setActiveView}
        />
      )}
    </div>
  )
}

interface FilesTabBodyProps {
  resources: ReturnType<typeof useWorkspaceResources>
  attachedCount: number
  query: string
  setQuery: (q: string) => void
  filtered: ReturnType<typeof useWorkspaceResources>
  selectedFileIds: string[]
  toggleFileSelection: (fileId: string) => void
  mounted: boolean
  error: string | null
  fileInputRef: React.RefObject<HTMLInputElement | null>
  handleUpload: (list: FileList | null) => void
  setActiveView: (view: "workspaces" | "chat" | "resources" | "editor") => void
}

function FilesTabBody({
  resources,
  attachedCount,
  query,
  setQuery,
  filtered,
  selectedFileIds,
  toggleFileSelection,
  mounted,
  error,
  fileInputRef,
  handleUpload,
  setActiveView,
}: FilesTabBodyProps) {
  return (
    <>
      {/* Header */}
      <div className="shrink-0 px-3 py-2.5 border-b border-[var(--border)] flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-[var(--muted-foreground)]">
            {resources.length} in workspace · {attachedCount} attached
          </p>
        </div>
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
          onClick={() => fileInputRef.current?.click()}
          aria-label="Upload files to workspace"
          title="Upload files"
          className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Search */}
      {resources.length > 0 && (
        <div className="shrink-0 px-3 py-2 border-b border-[var(--border)]">
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files"
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>
      )}

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
        {resources.length === 0 ? (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full h-full min-h-[120px] flex flex-col items-center justify-center gap-2 px-3 text-center text-xs text-[var(--muted-foreground)] italic rounded-md border border-dashed border-[var(--border)] hover:border-[var(--primary)] hover:text-[var(--foreground)] transition-colors"
          >
            <FolderOpen size={20} />
            <span>Upload files to add workspace context</span>
          </button>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-[var(--muted-foreground)]">
            No files match &ldquo;{query}&rdquo;
          </div>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((file) => {
              const attached = selectedFileIds.includes(file.id)
              return (
                <li key={file.id}>
                  <button
                    type="button"
                    onClick={() => toggleFileSelection(file.id)}
                    aria-pressed={attached}
                    title={file.name}
                    className={cn(
                      "w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                      attached
                        ? "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/40"
                        : "hover:bg-[var(--accent)]"
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 shrink-0 size-4 rounded-[4px] border inline-flex items-center justify-center transition-colors",
                        attached
                          ? "bg-[var(--primary)] border-[var(--primary)] text-[var(--primary-foreground)]"
                          : "border-[var(--border)] bg-transparent"
                      )}
                    >
                      {attached && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span className="mt-0.5">{getFileIcon(file.type)}</span>
                    <div className="flex-1 min-w-0">
                      <div
                        className={cn(
                          "text-xs font-medium truncate",
                          attached ? "text-[var(--primary)]" : "text-[var(--foreground)]"
                        )}
                      >
                        {file.name}
                      </div>
                      <div className="text-[10px] text-[var(--muted-foreground)] flex items-center gap-1.5 flex-wrap">
                        <span>
                          {formatFileSize(file.size)}
                          {mounted && (
                            <> · {format(new Date(file.uploadedAt), "MMM d, yyyy")}</>
                          )}
                        </span>
                        <ExtractionStatusBadge file={file} />
                        <FileAvailabilityBadge file={file} />
                      </div>
                      {file.keyTopics && file.keyTopics.length > 0 && (
                        <div
                          className="mt-1 text-[10px] text-[var(--muted-foreground)] truncate"
                          title={file.summary}
                        >
                          {file.keyTopics.slice(0, 4).join(" · ")}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {error && (
          <div className="mt-2 px-2 text-[11px] text-red-500" role="alert">
            {error}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 px-3 py-2 border-t border-[var(--border)]">
        <button
          type="button"
          onClick={() => setActiveView("resources")}
          className="text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        >
          Manage workspace files →
        </button>
      </div>
    </>
  )
}
