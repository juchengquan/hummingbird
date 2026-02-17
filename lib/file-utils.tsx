import { File, FileText, FileJson, Image } from "lucide-react"
import React from "react"

export function getFileIcon(type: string): React.ReactNode {
  if (type.includes("pdf")) return <FileText size={16} className="text-red-500 shrink-0" />
  if (type.includes("word") || type.includes("document"))
    return <FileText size={16} className="text-blue-500 shrink-0" />
  if (type.includes("image")) return <Image size={16} className="text-purple-500 shrink-0" aria-label="image" />
  if (type.includes("json")) return <FileJson size={16} className="text-yellow-500 shrink-0" />
  if (type.includes("csv") || type.includes("text"))
    return <FileText size={16} className="text-green-500 shrink-0" />
  return <File size={16} className="text-gray-500 shrink-0" />
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}
