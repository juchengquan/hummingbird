"use client"

import { Download, FileText } from "lucide-react"

import type { GeneratedFile } from "@/shared/types"

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

export function GeneratedFilesList({ files }: { files: GeneratedFile[] }) {
  if (files.length === 0) return null
  return (
    <div className="mt-2 mb-1 flex flex-wrap gap-2">
      {files.map((f) => (
        <a
          key={f.id}
          href={f.url}
          download={f.name}
          className="group flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)] px-2.5 py-1.5 text-xs hover:bg-[var(--accent)]"
        >
          <FileText className="size-4 shrink-0 text-[var(--muted-foreground)]" />
          <span className="max-w-[18ch] truncate font-medium">{f.name}</span>
          <span className="text-[var(--muted-foreground)]">{humanSize(f.sizeBytes)}</span>
          <Download className="size-3.5 shrink-0 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100" />
        </a>
      ))}
    </div>
  )
}
