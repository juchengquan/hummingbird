"use client"

import { useState, useRef, useCallback } from "react"
import { useStore, useSessionStore, UploadedFile } from "@/lib/hooks/use-store"
import { PanelContainer } from "@/components/panel-container"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Item, ItemMedia, ItemContent, ItemTitle, ItemDescription } from "@/components/ui/item"

import {
  Upload,
  File,
  Search,
  Trash2,
  Check,
  X,
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
import { formatFileSize, getFileIcon } from "@/lib/file-utils"
import { format } from "date-fns"

const FILE_SIZE_LIMIT = 50 * 1024 * 1024 // 50MB

const ALLOWED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/csv",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/jpg",
]

const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".csv", ".json", ".png", ".jpg", ".jpeg"]

function validateFile(file: File): string | null {
  if (file.size > FILE_SIZE_LIMIT) {
    return `File size exceeds ${formatFileSize(FILE_SIZE_LIMIT)} limit`
  }
  return null
}

export function ResourcePanel() {
  const { files, addFile, removeFile, clearFiles } = useStore()
  const { selectedFileIds, toggleFileSelection, setSelectedFileIds, clearSelectedFiles } = useSessionStore()
  const [searchQuery, setSearchQuery] = useState("")
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const filteredFiles = files.filter((file) =>
    file.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleFileSelect = useCallback(
    (selectedFiles: FileList | null) => {
      if (!selectedFiles) return

      setError(null)
      const newFiles: UploadedFile[] = []

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i]
        const validationError = validateFile(file)

        if (validationError) {
          setError(validationError)
          continue
        }

        const uploadedFile: UploadedFile = {
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          type: file.type,
          uploadedAt: new Date(),
        }
        newFiles.push(uploadedFile)
        addFile(uploadedFile)
      }
    },
    [addFile]
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
    removeFile(fileId)
  }

  return (
    <PanelContainer title="Resources XXXX">
      <div className="flex flex-col h-full">
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
                PDF, DOCX, TXT, CSV, JSON, PNG, JPG (max 50MB)
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
              <File size={32} className="text-[var(--muted-foreground)] mb-2" />
              <p className="text-sm text-[var(--muted-foreground)]">
                {searchQuery ? "No files found" : "No files uploaded yet"}
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
                      <HoverCardContent side="right" align="start" className="w-auto max-w-xs">
                        <p className="text-sm text-[var(--foreground)] break-all">{file.name}</p>
                        <p className="text-xs text-[var(--muted-foreground)] mt-1">
                          {formatFileSize(file.size)} • {format(file.uploadedAt, "MMM d, yyyy")}
                        </p>
                      </HoverCardContent>
                    </HoverCard>
                    <span className="text-xs text-[var(--muted-foreground)] shrink-0 ml-auto">
                      {formatFileSize(file.size)}
                      {/* • {format(file.uploadedAt, "MMM d")} */}
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
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmDeleteId(file.id)
                      }}
                      className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--destructive)] transition-all"
                      aria-label="Remove file"
                    >
                      <X size={14} className="text-[var(--muted-foreground)]" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Total files uploaded */}
        <div className="px-3 py-2 border-t border-[var(--border)] flex items-center justify-between">
          <span className="text-sm text-[var(--muted-foreground)]">
            {files.length} {files.length === 1 ? "file" : "files"} uploaded
          </span>
          {files.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs text-[var(--muted-foreground)] hover:bg-destructive hover:text-white">
                  Delete all
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete all files?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete all {files.length} uploaded files. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={clearFiles}>Delete</AlertDialogAction>
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
    </PanelContainer>
  )
}
