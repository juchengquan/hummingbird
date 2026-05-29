"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"
import {
  openCsvViewer,
  openDocxViewer,
  openImageViewer,
  openPdf,
  openTextViewer,
} from "@/components/right-panel-slot"
import {
  useStore,
  useWorkspaceResources,
  useConversationSelectedFileIds,
  useConversationPrivateFiles,
} from "@/client/hooks/use-store"
import { processSelectedFiles } from "@/client/file-utils"
import { FILE_SIZE_LIMIT, IMAGE_SIZE_LIMIT } from "@/shared/upload-config"
import { runExtraction } from "@/client/extract"
import { persistFile } from "@/client/files/persist"
import { NotesTab } from "@/components/panels/notes-tab"
import { ArtifactsTab } from "@/components/panels/artifacts-tab"
import { PinsTab } from "@/components/panels/pins-tab"
import { SkillsTab } from "@/components/panels/skills-tab"
import { McpTab } from "@/components/panels/mcp-tab"
import { ProjectTasksPanel } from "@/components/panels/project-tasks-panel"
import { UrlBookmarksTab } from "@/components/panels/url-bookmarks-tab"
import { FilesTabBody } from "@/components/panels/files-tab-body"
import { ConversationFilesSection } from "@/components/panels/conversation-files-section"

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
  const activeConversationId = useStore((s) => s.activeConversationId)
  const addFile = useStore((s) => s.addFile)
  const addResource = useStore((s) => s.addResource)
  const addConversationFile = useStore((s) => s.addConversationFile)
  const removeConversationFile = useStore((s) => s.removeConversationFile)
  const removeFile = useStore((s) => s.removeFile)
  const setFileExtraction = useStore((s) => s.setFileExtraction)
  const setFileStorage = useStore((s) => s.setFileStorage)
  const setActiveView = useStore((s) => s.setActiveView)
  const toggleFileSelection = useStore((s) => s.toggleConversationFileSelection)
  const selectedFileIds = useConversationSelectedFileIds()
  const resources = useWorkspaceResources()
  const privateFiles = useConversationPrivateFiles()
  const files = useStore((s) => s.files)

  // Look up the file metadata then dispatch into the shared image
  // viewer drawer. Shared between the workspace files list and the
  // per-conversation private files section so both surfaces preview
  // images via the same path.
  const handleOpenImage = (fileId: string) => {
    const file = files.find((f) => f.id === fileId)
    if (!file?.imageDataUrl) return
    openImageViewer({
      images: [
        {
          id: file.id,
          url: file.imageDataUrl,
          alt: file.name,
          filename: file.name,
          sizeBytes: file.size,
          format: (file.type.split("/")[1] ?? "png").toLowerCase(),
        },
      ],
    })
  }

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  // In manage mode, the trash button stages a confirmation rather than
  // deleting immediately. Holds the file id pending confirmation.
  const [confirmDeleteFileId, setConfirmDeleteFileId] = useState<string | null>(
    null
  )
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

  /**
   * Upload to the conversation-private lane: the file is added to
   * `files[]` and joined via `conversationFiles` — it does **not** get
   * a `resources` row, so it never appears in the workspace library.
   * No-op when there's no active conversation.
   */
  const handlePrivateUpload = useCallback(
    (list: FileList | null) => {
      if (!activeConversationId) return
      setError(null)
      const processed = processSelectedFiles(list, {
        maxSize: FILE_SIZE_LIMIT,
        maxImageSize: IMAGE_SIZE_LIMIT,
        onValidationError: setError,
      })
      processed.forEach(({ meta, source }) => {
        addFile(meta)
        addConversationFile(activeConversationId, meta.id)
        void runExtraction(meta.id, source, setFileExtraction)
        void persistFile(source, meta.id, meta.name).then((result) => {
          if (result.storagePath) {
            setFileStorage(meta.id, { storagePath: result.storagePath })
          }
        })
      })
    },
    [
      activeConversationId,
      addFile,
      addConversationFile,
      setFileExtraction,
      setFileStorage,
    ]
  )

  return (
    <div className="flex flex-col w-full h-full min-h-0">
      {/* Tab strip removed — the icon column in <ResourcesSidebar/> is the
          tab switcher now. Just render the active tab's body. */}
      {tab === "project" ? (
        <ProjectTasksPanel />
      ) : tab === "notes" ? (
        <NotesTab />
      ) : tab === "artifacts" ? (
        <ArtifactsTab />
      ) : tab === "pins" ? (
        <PinsTab />
      ) : tab === "skills" ? (
        <SkillsTab />
      ) : tab === "mcp" ? (
        <McpTab />
      ) : tab === "links" ? (
        <UrlBookmarksTab />
      ) : (
        <div className="flex flex-col h-full min-h-0">
          {mode === "chat" && activeConversationId && (
            <ConversationFilesSection
              files={privateFiles}
              conversationId={activeConversationId}
              onUpload={handlePrivateUpload}
              onRemove={(fileId) =>
                removeConversationFile(activeConversationId, fileId)
              }
              onOpenPdf={(fileId) => openPdf({ fileId })}
              onOpenImage={handleOpenImage}
              onOpenDocx={(fileId) => openDocxViewer({ fileId })}
              onOpenText={(fileId) => openTextViewer({ fileId })}
              onOpenCsv={(fileId) => openCsvViewer({ fileId })}
            />
          )}
          <div className="flex-1 min-h-0 flex flex-col">
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
              onOpenPdf={(fileId) => openPdf({ fileId })}
              onOpenImage={handleOpenImage}
              onOpenDocx={(fileId) => openDocxViewer({ fileId })}
              onOpenText={(fileId) => openTextViewer({ fileId })}
              onOpenCsv={(fileId) => openCsvViewer({ fileId })}
              mounted={mounted}
              error={error}
              fileInputRef={fileInputRef}
              handleUpload={handleUpload}
              setActiveView={setActiveView}
            />
          </div>
        </div>
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
