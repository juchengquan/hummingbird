"use client"
import "client-only"

/**
 * `useChatDropzone` — the file-drop overlay state + event handlers for
 * the chat input card. Lifted out of `components/panels/chat.tsx`.
 *
 * The drop ingestion itself (file size validation, IndexedDB persist,
 * extraction kick-off) stays in the panel via the `onFiles` callback
 * — it's the same handler the `+`-button file picker uses, so binding
 * it here keeps the two surfaces consistent.
 */

import { useCallback, useState } from "react"

export interface UseChatDropzoneOptions {
  /** Called with the `FileList` of dropped files. Same callback the
   *  panel's `+`-button file picker uses, so the ingestion path
   *  matches exactly. */
  onFiles: (files: FileList) => void
}

export interface UseChatDropzoneResult {
  /** True while a drag with `Files` payload is hovering the dropzone.
   *  Drives the highlight border. */
  active: boolean
  /** Spread on the drop-target wrapper. */
  bindings: {
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

export function useChatDropzone({
  onFiles,
}: UseChatDropzoneOptions): UseChatDropzoneResult {
  const [active, setActive] = useState(false)

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
      if (!active) setActive(true)
    },
    [active]
  )

  const onDragLeave = useCallback((e: React.DragEvent) => {
    // `dragleave` fires for every child crossing; only clear when
    // we leave the wrapper itself.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setActive(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      setActive(false)
      onFiles(e.dataTransfer.files)
    },
    [onFiles]
  )

  return { active, bindings: { onDragOver, onDragLeave, onDrop } }
}
