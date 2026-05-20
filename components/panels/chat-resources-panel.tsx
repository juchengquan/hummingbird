"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"
import { usePdfViewer } from "@/components/pdf-viewer/types"
import {
  useStore,
  useWorkspaceResources,
  useConversationSelectedFileIds,
} from "@/lib/hooks/use-store"
import { processSelectedFiles } from "@/lib/file-utils"
import { FILE_SIZE_LIMIT, IMAGE_SIZE_LIMIT } from "@/lib/upload-config"
import { runExtraction } from "@/lib/extract"
import { persistFile } from "@/lib/files/persist"
import { NotesTab } from "@/components/panels/notes-tab"
import { ArtifactsTab } from "@/components/panels/artifacts-tab"
import { SkillsTab } from "@/components/panels/skills-tab"
import { FilesTabBody } from "@/components/panels/files-tab-body"

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
  // `mode` only affects how the Files tab renders (manage vs attach). The
  // active tab itself always follows the persisted `resourcesSidebarTab`
  // so the rail can switch between Files/Notes/Artifacts/Skills regardless
  // of whether we're in a chat or a workspace view.
  const tab = useStore((s) => s.resourcesSidebarTab)

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
      <DeleteConfirmDialog
        open={confirmDeleteFileId !== null}
        onOpenChange={(open) => !open && setConfirmDeleteFileId(null)}
        title={
          <>
            Delete &ldquo;
            {confirmDeleteFileId
              ? resources.find((r) => r.id === confirmDeleteFileId)?.name ?? "file"
              : "file"}
            &rdquo;?
          </>
        }
        description={
          <>
            This removes the file from the workspace and deletes its local
            blob.{" "}
            <span className="font-medium text-[var(--foreground)]">
              This action cannot be undone.
            </span>
          </>
        }
        onConfirm={() => {
          if (confirmDeleteFileId) removeFile(confirmDeleteFileId)
        }}
      />
    </div>
  )
}
