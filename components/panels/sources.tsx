"use client"

import { useState, useRef, useCallback } from "react"
import { useStore, useSessionStore, useWorkspaceResources } from "@/lib/hooks/use-store"
import { Item, ItemMedia, ItemContent, ItemTitle, ItemDescription } from "@/components/ui/item"

import {
  Upload,
  File,
  Search,
  Trash2,
  Check,
  X,
  FolderOpen,
} from "lucide-react"
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import { formatFileSize, getFileIcon, processSelectedFiles } from "@/lib/file-utils"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { runExtraction } from "@/lib/extract"
import { persistFile } from "@/lib/files/persist"
import { FILE_SIZE_LIMIT, IMAGE_SIZE_LIMIT } from "@/lib/upload-config"
import { ExtractionStatusBadge } from "@/components/panels/extraction-status-badge"
import { format } from "date-fns"


const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".csv", ".json", ".png", ".jpg", ".jpeg"]

export function ResourcePanel() {
  const {
    files,
    addFile,
    removeFile,
    clearFiles,
    activeWorkspaceId,
    resources,
    addResource,
    removeResource,
    setFileExtraction,
    setFileStorage,
  } = useStore()
  const { selectedFileIds, toggleFileSelection, clearSelectedFiles } = useSessionStore()
  const [searchQuery, setSearchQuery] = useState("")
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const workspaceResources = useWorkspaceResources()

  // Filter files that are resources of the current workspace
  const resourceFileIds = resources
    .filter(r => r.workspaceId === activeWorkspaceId)
    .map(r => r.fileId)

  const filteredFiles = files.filter((file) =>
    resourceFileIds.includes(file.id) &&
    file.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleFileSelect = useCallback(
    (selectedFiles: FileList | null) => {
      if (!selectedFiles) return

      setError(null)

      const processed = processSelectedFiles(selectedFiles, {
        maxSize: FILE_SIZE_LIMIT,
        maxImageSize: IMAGE_SIZE_LIMIT,
        onValidationError: setError,
      })

      processed.forEach(({ meta, source }) => {
        addFile(meta)
        // Automatically add as resource to current workspace
        addResource(activeWorkspaceId, meta.id)
        void runExtraction(meta.id, source, setFileExtraction)
        void persistFile(source, meta.id, meta.name).then((result) => {
          if (result.storagePath) {
            setFileStorage(meta.id, { storagePath: result.storagePath })
          }
        })
      })
    },
    [addFile, addResource, activeWorkspaceId, setFileExtraction, setFileStorage]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      handleFileSelect(e.dataTransfer.files)
    },
    [handleFileSelect]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleRemoveFile = (fileId: string) => {
    // Remove from workspace resources
    const resource = resources.find(r => r.workspaceId === activeWorkspaceId && r.fileId === fileId)
    if (resource) {
      removeResource(resource.id)
    }
    // If file is not used by other workspaces, delete it
    const otherWorkspacesUsingFile = resources.some(r => r.fileId === fileId && r.workspaceId !== activeWorkspaceId)
    if (!otherWorkspacesUsingFile) {
      removeFile(fileId)
    }
  }

  return (
    <div className="flex flex-col h-full w-full">
        {/* Mobile-only header — surfaces the SidebarTrigger so users can
            reopen the (closed-by-default) left sidebar on phones. */}
        <div className="md:hidden shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
          <SidebarTrigger />
          <h2 className="text-sm font-medium text-[var(--foreground)]">Files</h2>
        </div>
        {/* Drop zone */}
        <div
          className={cn(
            "m-2 p-2 border-2 border-dashed rounded-lg transition-colors cursor-pointer",
            isDragOver
              ? "border-[var(--primary)] bg-[var(--primary)]/10"
              : "border-[var(--border)] hover:border-[var(--primary)]"
          )}
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_EXTENSIONS.join(",")}
            onChange={(e) => handleFileSelect(e.target.files)}
            className="hidden"
          />
          <Item className="flex flex-col items-center text-center border-0 p-0 shadow-none !w-full">
            <ItemContent className="w-full items-center">
              <ItemTitle className="justify-center text-center w-full text-[var(--foreground)] text-xs">
                Drop files here or click to upload
              </ItemTitle>
              <ItemDescription className="text-center text-xs w-full">
                PDF, DOCX, TXT, CSV, JSON, PNG, JPG (max 5MB)
              </ItemDescription>
            </ItemContent>
          </Item>
        </div>

        {/* Error message */}
        {error && (
          <div className="mx-3 mb-2 p-2 bg-[var(--destructive)]/20 border border-[var(--destructive)] rounded text-sm text-[var(--destructive-foreground)]">
            {error}
          </div>
        )}

        {/* Search */}
        <div className="px-2 pb-2 border-[var(--border)]">
          {/* <div className="relative"> */}
          <InputGroup>
            <InputGroupAddon align="inline-start">
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              type="text"
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                setConfirmDeleteId(null)
              }}
            />
          </InputGroup>
        </div>

        {/* File list */}
        <div className="mx-2 rounded-lg max-h-[60vh] flex-1 overflow-y-auto border">
          {filteredFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-4">
              <FolderOpen size={32} className="text-[var(--muted-foreground)] mb-2" />
              <p className="text-sm text-[var(--muted-foreground)]">
                {searchQuery ? "No files found" : "No resources in this workspace"}
              </p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                Upload files to add them as resources
              </p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filteredFiles.map((file) => (
                <div
                  key={file.id}
                  className={cn(
                    "group flex items-center gap-2 p-2 rounded-md cursor-pointer transition-all border",
                    selectedFileIds.includes(file.id)
                      ? "bg-[var(--primary)]/10 border-[var(--primary)]"
                      : "hover:bg-[var(--secondary)] border-transparent"
                  )}
                  onClick={() => toggleFileSelection(file.id)}
                >
                  {/* Checkbox */}
                  <Checkbox
                    checked={selectedFileIds.includes(file.id)}
                    onCheckedChange={() => toggleFileSelection(file.id)}
                    onClick={(e) => e.stopPropagation()}
                  />

                  {/* File icon and info */}
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <HoverCard openDelay={300}>
                      <HoverCardTrigger asChild>
                        <div className="flex items-center gap-2 cursor-default min-w-0">
                          {getFileIcon(file.type)}
                          <p className="text-sm text-[var(--foreground)] truncate">
                            {file.name}
                          </p>
                        </div>
                      </HoverCardTrigger>
                      <HoverCardContent side="right" align="start" className="w-80 max-w-xs">
                        <p className="text-sm font-medium text-[var(--foreground)] break-all">{file.name}</p>
                        <p className="text-xs text-[var(--muted-foreground)] mt-1">
                          {formatFileSize(file.size)} • {format(file.uploadedAt, "MMM d, yyyy")}
                        </p>
                        {file.summary && (
                          <p className="mt-2 text-xs text-[var(--foreground)] leading-relaxed">
                            {file.summary}
                          </p>
                        )}
                        {file.keyTopics && file.keyTopics.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {file.keyTopics.map((topic) => (
                              <span
                                key={topic}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--secondary)] text-[var(--muted-foreground)]"
                              >
                                {topic}
                              </span>
                            ))}
                          </div>
                        )}
                      </HoverCardContent>
                    </HoverCard>
                    <ExtractionStatusBadge file={file} size="default" className="shrink-0 ml-auto" />
                    <span className="text-xs text-[var(--muted-foreground)] shrink-0">
                      {formatFileSize(file.size)}
                    </span>
                  </div>

                  {/* Delete button */}
                  {confirmDeleteId === file.id ? (
                    <div className="flex items-center gap-1 opacity-100" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveFile(file.id)}
                        className="h-6 w-6 text-[var(--destructive)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                      >
                        <Check size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setConfirmDeleteId(null)}
                        className="h-6 w-6"
                      >
                        <X size={14} />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmDeleteId(file.id)
                      }}
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30"
                      aria-label="Remove file"
                    >
                      <X size={14} />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Total files in workspace */}
        <div className="px-3 py-2 border-t border-[var(--border)] flex items-center justify-between">
          <span className="text-sm text-[var(--muted-foreground)]">
            {filteredFiles.length} {filteredFiles.length === 1 ? "resource" : "resources"} in workspace
          </span>
          {filteredFiles.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs text-[var(--muted-foreground)] hover:bg-destructive hover:text-white">
                  Remove all
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove all resources from workspace?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove all {filteredFiles.length} files from this workspace. The files will still be available in other workspaces.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => {
                    filteredFiles.forEach(file => handleRemoveFile(file.id))
                  }}>Remove</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        {/* Selected files count */}
        {selectedFileIds.length > 0 && (
          <div className="px-3 py-2 border-[var(--border)] flex items-center justify-between">
            <span className="text-sm text-[var(--muted-foreground)]">
              {selectedFileIds.length} selected
            </span>
            <button
              onClick={clearSelectedFiles}
              className="text-xs text-[var(--primary)] hover:underline"
            >
              Clear selection
            </button>
          </div>
        )}
    </div>
  )
}
