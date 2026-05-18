"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { format } from "date-fns"
import { Search, Plus, FolderOpen, Check, StickyNote } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import {
  useStore,
  useWorkspaceResources,
  useConversationSelectedFileIds,
  useConversationNotes,
} from "@/lib/hooks/use-store"
import { getFileIcon, processSelectedFiles, formatFileSize } from "@/lib/file-utils"
import { NotesTab } from "@/components/panels/notes-tab"

type Tab = "files" | "notes"

const FILE_SIZE_LIMIT = 5 * 1024 * 1024 // 5MB
const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".csv", ".json", ".png", ".jpg", ".jpeg"]

export function ChatResourcesPanel() {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const addFile = useStore((s) => s.addFile)
  const addResource = useStore((s) => s.addResource)
  const setActiveView = useStore((s) => s.setActiveView)
  const toggleFileSelection = useStore((s) => s.toggleConversationFileSelection)
  const selectedFileIds = useConversationSelectedFileIds()
  const resources = useWorkspaceResources()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const [tab, setTab] = useState<Tab>("files")
  const notesCount = useConversationNotes().length

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

  return (
    <aside className="hidden lg:flex flex-col w-80 h-full min-h-0 shrink-0 border-l border-[var(--border)] bg-[var(--background)]/60">
      {/* Tab strip */}
      <div className="shrink-0 flex border-b border-[var(--border)]">
        <button
          type="button"
          onClick={() => setTab("files")}
          className={cn(
            "flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors",
            tab === "files"
              ? "text-[var(--foreground)] border-b-2 border-[var(--primary)] -mb-px"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          )}
        >
          <FolderOpen size={13} />
          Files
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {resources.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setTab("notes")}
          className={cn(
            "flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors",
            tab === "notes"
              ? "text-[var(--foreground)] border-b-2 border-[var(--primary)] -mb-px"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          )}
        >
          <StickyNote size={13} />
          Notes
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {notesCount}
          </span>
        </button>
      </div>

      {tab === "notes" ? (
        <NotesTab />
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
    </aside>
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
                      <div className="text-[10px] text-[var(--muted-foreground)]">
                        {formatFileSize(file.size)}
                        {mounted && (
                          <> · {format(new Date(file.uploadedAt), "MMM d, yyyy")}</>
                        )}
                      </div>
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
