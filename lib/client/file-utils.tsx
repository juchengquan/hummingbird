import "client-only"
import { File as FileIcon, FileText, FileJson, Image } from "lucide-react"
import React from "react"
import type { UploadedFile } from "@/shared/types"
import { uuid } from "@/shared/uuid"

// Default file validation (5MB limit)
const DEFAULT_SIZE_LIMIT = 5 * 1024 * 1024

export interface ProcessedFile {
  /** Metadata describing the file after validation. */
  meta: UploadedFile
  /** Original `File` blob, so callers can hand it to extraction or upload pipelines. */
  source: File
}

export function processSelectedFiles(
  files: FileList | null,
  options: {
    maxSize?: number
    /** Tighter cap applied only to image MIME types. Defaults to `maxSize`. */
    maxImageSize?: number
    onValidationError?: (error: string) => void
  } = {}
): ProcessedFile[] {
  const {
    maxSize = DEFAULT_SIZE_LIMIT,
    maxImageSize = maxSize,
    onValidationError,
  } = options

  if (!files) return []

  const processed: ProcessedFile[] = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const isImage = file.type.startsWith('image/')
    const limit = isImage ? maxImageSize : maxSize

    // Validate file size
    if (file.size > limit) {
      onValidationError?.(
        `${isImage ? 'Image' : 'File'} "${file.name}" exceeds ${formatFileSize(limit)} limit`
      )
      continue
    }

    processed.push({
      meta: {
        id: uuid(),
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        uploadedAt: new Date(),
        extractionStatus: 'pending',
      },
      source: file,
    })
  }

  return processed
}

export function getFileIcon(type: string): React.ReactNode {
  if (type.includes("pdf")) return <FileText size={16} className="text-red-500 shrink-0" />
  if (type.includes("word") || type.includes("document"))
    return <FileText size={16} className="text-blue-500 shrink-0" />
  if (type.includes("image")) return <Image size={16} className="text-purple-500 shrink-0" aria-label="image" />
  if (type.includes("json")) return <FileJson size={16} className="text-yellow-500 shrink-0" />
  if (type.includes("csv") || type.includes("text"))
    return <FileText size={16} className="text-green-500 shrink-0" />
  return <FileIcon size={16} className="text-gray-500 shrink-0" />
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}
