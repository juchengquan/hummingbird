"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { format } from "date-fns"
import { Search, Plus, FolderOpen, Check, Trash2, Eye } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { usePdfViewer } from "@/components/pdf-viewer/types"
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
import { SkillsTab } from "@/components/panels/skills-tab"
import { FileRowMeta } from "@/components/panels/file-row-meta"

interface ChatResourcesPanelProps {
  /**
   * `chat` (default): tabbed view driven by `resourcesSidebarTab`. Files tab
   * lets the user attach files to the active conversation.
   *
   * `manage`: forces the Files tab only, with no conversation context. Used
   * by the workspaces view of the right rail. Hides attach checkboxes and
   * the "Manage workspace files →" footer; adds per-row delete buttons.
   */
  mode?: "chat" | "manage"
}

export function ChatResourcesPanel({ mode = "chat" }: ChatResourcesPanelProps = {}) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const addFile = useStore((s) => s.addFile)
  const addResource = useStore((s) => s.addResource)
  const removeFile = useStore((s) => s.removeFile)
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
  // In manage mode, the trash button stages a confirmation rather than
  // deleting immediately. Holds the file id pending confirmation.
  const [confirmDeleteFileId, setConfirmDeleteFileId] = useState<string | null>(
    null
  )
  const openPdfViewer = usePdfViewer((s) => s.open)
  const storedTab = useStore((s) => s.resourcesSidebarTab)
  const tab = mode === "manage" ? "files" : storedTab

  // Mount flag for date formatting (avoid SSR mismatch). Must live in
  // useEffect — calling setMounted from render (even via queueMicrotask)
  // schedules an update against an unmounted component on first paint.
  useEffect(() => {
    setMounted(true)
  }, [])

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
      ) : tab === "skills" ? (
        <SkillsTab />
      ) : (
        <FilesTabBody
          mode={mode}
          resources={resources}
          attachedCount={attachedCount}
          query={query}
          setQuery={setQuery}
          filtered={filtered}
          selectedFileIds={selectedFileIds}
          toggleFileSelection={toggleFileSelection}
          onRequestDelete={setConfirmDeleteFileId}
          onOpenPdf={(fileId) => openPdfViewer({ fileId })}
          mounted={mounted}
          error={error}
          fileInputRef={fileInputRef}
          handleUpload={handleUpload}
          setActiveView={setActiveView}
        />
      )}
      {/* Delete confirmation — only relevant in manage mode but the dialog
          itself is harmless when never opened. */}
      <AlertDialog
        open={confirmDeleteFileId !== null}
        onOpenChange={(open) => !open && setConfirmDeleteFileId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &ldquo;
              {confirmDeleteFileId
                ? resources.find((r) => r.id === confirmDeleteFileId)?.name ??
                  "file"
                : "file"}
              &rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the file from the workspace and deletes its local
              blob.{" "}
              <span className="font-medium text-[var(--foreground)]">
                This action cannot be undone.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDeleteFileId) removeFile(confirmDeleteFileId)
                setConfirmDeleteFileId(null)
              }}
              className="bg-[var(--destructive)] text-white hover:bg-[var(--destructive)]/90 focus-visible:ring-[var(--destructive)]/40"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface FilesTabBodyProps {
  mode: "chat" | "manage"
  resources: ReturnType<typeof useWorkspaceResources>
  attachedCount: number
  query: string
  setQuery: (q: string) => void
  filtered: ReturnType<typeof useWorkspaceResources>
  selectedFileIds: string[]
  toggleFileSelection: (fileId: string) => void
  /** Stages a deletion — the parent shows the confirmation dialog. */
  onRequestDelete: (fileId: string) => void
  onOpenPdf: (fileId: string) => void
  mounted: boolean
  error: string | null
  fileInputRef: React.RefObject<HTMLInputElement | null>
  handleUpload: (list: FileList | null) => void
  setActiveView: (view: "workspaces" | "chat" | "resources" | "editor") => void
}

function FilesTabBody({
  mode,
  resources,
  attachedCount,
  query,
  setQuery,
  filtered,
  selectedFileIds,
  toggleFileSelection,
  onRequestDelete,
  onOpenPdf,
  mounted,
  error,
  fileInputRef,
  handleUpload,
  setActiveView,
}: FilesTabBodyProps) {
  const isManage = mode === "manage"
  return (
    <>
      {/* Header */}
      <div className="shrink-0 h-11 px-3 border-b border-[var(--border)] flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-[var(--muted-foreground)]">
            {isManage
              ? `${resources.length} ${resources.length === 1 ? "file" : "files"}`
              : `${resources.length} in workspace · ${attachedCount} attached`}
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
              const attached = !isManage && selectedFileIds.includes(file.id)
              return (
                <li key={file.id} className="group/row relative">
                  {/* Outer is a div (not button) so the Re-extract button
                      inside FileRowMeta can nest without invalid HTML. The
                      role + keyboard handler restore button semantics. */}
                  <div
                    role={isManage ? undefined : "button"}
                    tabIndex={isManage ? undefined : 0}
                    onClick={isManage ? undefined : () => toggleFileSelection(file.id)}
                    onKeyDown={isManage ? undefined : (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        toggleFileSelection(file.id)
                      }
                    }}
                    aria-pressed={isManage ? undefined : attached}
                    title={file.name}
                    className={cn(
                      "w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                      // Reserve right-side gutter for the action buttons
                      // (View / Delete). 14 = 56px = fits 2 small icon
                      // buttons with breathing room.
                      isManage ? "hover:bg-[var(--accent)] pr-14" : attached
                        ? "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/40 cursor-pointer pr-8"
                        : "hover:bg-[var(--accent)] cursor-pointer pr-8"
                    )}
                  >
                    {!isManage && (
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
                    )}
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
                        <FileRowMeta file={file} />
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
                  </div>
                  {/* Right-side action cluster — View (PDFs only) +
                      Delete (manage mode only). Both fade in on row hover.
                      stopPropagation so clicking doesn't toggle attach. */}
                  {(() => {
                    const isPdf =
                      file.type === "application/pdf" ||
                      file.name.toLowerCase().endsWith(".pdf")
                    if (!isPdf && !isManage) return null
                    return (
                      <div
                        className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                      >
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
                        {isManage && (
                          <button
                            type="button"
                            onClick={() => onRequestDelete(file.id)}
                            aria-label={`Delete ${file.name}`}
                            title="Delete file"
                            className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)] transition-colors"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    )
                  })()}
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

      {/* Footer — only shown in chat mode (manage mode IS this management surface). */}
      {!isManage && (
        <div className="shrink-0 px-3 py-2 border-t border-[var(--border)]">
          <button
            type="button"
            onClick={() => setActiveView("resources")}
            className="text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            Manage workspace files →
          </button>
        </div>
      )}
    </>
  )
}
