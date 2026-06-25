"use client"

import { useRef } from "react"
import { Download, FileText } from "lucide-react"

import { apiClient } from "@/client/api-client"
import { triggerDownload } from "@/client/download"
import { useStore } from "@/client/hooks/use-store"
import type { GeneratedFile } from "@/shared/types"

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

/** A chip can lazily re-sign its URL only when (1) the bytes are in
 *  Supabase Storage (has a `storagePath`) and (2) we know which message
 *  to update afterwards. Data-URL / local files download directly. */
export function shouldRefreshFile(
  file: GeneratedFile,
  messageId: string | undefined,
): boolean {
  return !!file.storagePath && !!messageId
}

function FileChip({
  file,
  messageId,
}: {
  file: GeneratedFile
  messageId?: string
}) {
  const updateFileUrl = useStore((s) => s.updateMessageGeneratedFileUrl)
  // Guard a rapid double-click while a re-sign is in flight. Resets after
  // each attempt so a later click re-signs again (URLs are short-lived).
  const inFlight = useRef(false)
  const canRefresh = shouldRefreshFile(file, messageId)

  const onClick = canRefresh
    ? async (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault()
        if (inFlight.current) return
        inFlight.current = true
        try {
          const fresh = await apiClient.files.refreshUrl(file.storagePath!)
          if (fresh) updateFileUrl(messageId!, file.id, fresh)
          triggerDownload(fresh ?? file.url, file.name)
        } finally {
          inFlight.current = false
        }
      }
    : undefined

  return (
    <a
      href={file.url}
      download={file.name}
      onClick={onClick}
      className="group flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)] px-2.5 py-1.5 text-xs hover:bg-[var(--accent)]"
    >
      <FileText className="size-4 shrink-0 text-[var(--muted-foreground)]" />
      <span className="max-w-[18ch] truncate font-medium">{file.name}</span>
      <span className="text-[var(--muted-foreground)]">{humanSize(file.sizeBytes)}</span>
      <Download className="size-3.5 shrink-0 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100" />
    </a>
  )
}

export function GeneratedFilesList({
  files,
  messageId,
}: {
  files: GeneratedFile[]
  messageId?: string
}) {
  if (files.length === 0) return null
  return (
    <div className="mt-2 mb-1 flex flex-wrap gap-2">
      {files.map((f) => (
        <FileChip key={f.id} file={f} messageId={messageId} />
      ))}
    </div>
  )
}
