"use client"
import "client-only"

import { useEffect, useMemo, useSyncExternalStore } from "react"

import type { UploadedFile } from "@/shared/types"

import {
  getCachedFileBlobFields,
  getFileBlobFields,
  pickBlobFields,
  subscribeFileBlobFields,
  type FileBlobFields,
} from "./blob-fields"

type FileArg =
  | (Pick<UploadedFile, "id"> & FileBlobFields & Partial<Pick<UploadedFile, "deletedAt">>)
  | null
  | undefined

const EMPTY: FileBlobFields = Object.freeze({}) as FileBlobFields

/**
 * Lazily resolve a file's IndexedDB-backed fields (`imageDataUrl`,
 * `extractedFullText`) for rendering. Returns `{}` until loaded, then
 * re-renders. Pass `null` to skip loading (e.g. only load full text
 * when a badge actually needs it). The row's own in-memory fields win.
 */
export function useFileBlobFields(file: FileArg): FileBlobFields {
  const id = file && !file.deletedAt ? file.id : null
  const cached = useSyncExternalStore(
    subscribeFileBlobFields,
    () => (id ? getCachedFileBlobFields(id) : undefined),
    () => undefined
  )
  const ownImage = file?.imageDataUrl
  const ownFullText = file?.extractedFullText

  useEffect(() => {
    if (!id) return
    void getFileBlobFields({ id })
  }, [id])

  return useMemo(() => {
    if (!id) return EMPTY
    const own = pickBlobFields({ imageDataUrl: ownImage, extractedFullText: ownFullText })
    if (!own && !cached) return EMPTY
    return { ...cached, ...own }
  }, [id, cached, ownImage, ownFullText])
}

/** Convenience: just the image data URL (or `undefined`). */
export function useFileImageDataUrl(file: FileArg): string | undefined {
  return useFileBlobFields(file).imageDataUrl
}
