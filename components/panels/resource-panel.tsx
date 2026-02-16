"use client"

import { useState, useRef, useCallback } from "react"
import { useStore, UploadedFile } from "@/lib/hooks/use-store"
import { PanelContainer } from "@/components/panel-container"
import {
  Upload,
  File,
  FileText,
  FileJson,
  Image,
  Search,
  Trash2,
  Check,
  X,
} from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
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

function getFileIcon(type: string) {
  if (type.includes("pdf")) return <FileText size={20} className="text-red-500" />
  if (type.includes("word") || type.includes("document"))
    return <FileText size={20} className="text-blue-500" />
  if (type.includes("image")) return <Image size={20} className="text-purple-500" />
  if (type.includes("json")) return <FileJson size={20} className="text-yellow-500" />
  if (type.includes("csv") || type.includes("text"))
    return <FileText size={20} className="text-green-500" />
  return <File size={20} className="text-gray-500" />
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}

function validateFile(file: File): string | null {
  if (file.size > FILE_SIZE_LIMIT) {
    return `File size exceeds ${formatFileSize(FILE_SIZE_LIMIT)} limit`
  }
  return null
}

export function ResourcePanel() {
  const { files, selectedFileIds, addFile, removeFile, toggleFileSelection, clearSelectedFiles } =
    useStore()
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
    <PanelContainer title="Resources">
      <div className="flex flex-col h-full">
        {/* Drop zone */}
        <div
          className={cn(
            "m-3 p-4 border-2 border-dashed rounded-lg transition-colors cursor-pointer",
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
          <div className="flex flex-col items-center text-center">
            <Upload
              size={24}
              className={cn(
                "mb-2",
                isDragOver
                  ? "text-[var(--primary)]"
                  : "text-[var(--muted-foreground)]"
              )}
            />
            <p className="text-sm text-[var(--foreground)]">
              Drop files here or click to upload
            </p>
            <p className="text-xs text-[var(--muted-foreground)] mt-1">
              PDF, DOCX, TXT, CSV, JSON, PNG, JPG (max 50MB)
            </p>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mx-3 mb-2 p-2 bg-[var(--destructive)]/20 border border-[var(--destructive)] rounded text-sm text-[var(--destructive-foreground)]">
            {error}
          </div>
        )}

        {/* Search */}
        <div className="px-3 pb-3 border-b border-[var(--border)]">
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
            />
            <input
              type="text"
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                setConfirmDeleteId(null)
              }}
              className="w-full pl-9 pr-3 py-2 bg-[var(--secondary)] border border-[var(--border)] rounded-md text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-[var(--primary)]"
            />
          </div>
        </div>

        {/* Selected files count */}
        {selectedFileIds.length > 0 && (
          <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
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

        {/* File list */}
        <div className="flex-1 overflow-y-auto">
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

                  {/* File icon */}
                  {getFileIcon(file.type)}

                  {/* File info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[var(--foreground)] truncate">
                      {file.name}
                    </p>
                    <p className="text-xs text-[var(--muted-foreground)]">
                      {formatFileSize(file.size)} • {format(file.uploadedAt, "MMM d")}
                    </p>
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
      </div>
    </PanelContainer>
  )
}
