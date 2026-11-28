import "client-only"

import type { UploadedFile } from "@/shared/types"
import {
  clearAllFileBlobFields,
  clearFileBlobFields,
  FILE_BLOB_FIELDS,
  type FileBlobField,
} from "@/client/files/blob-fields"
import { clearAll as clearLocalBlobs } from "@/client/files/local-store"
import {
  deleteFileLocalData,
  stripSelectionId,
  tombstoneFile,
} from "@/client/store/cascade"

import type { SliceCreator } from "../types"

/**
 * Files slice — the `UploadedFile` metadata rows. `removeFile` /
 * `clearFiles` own a cascade that drops the file's join rows
 * (`resources`, `conversationFiles`) and strips it from every
 * conversation's `selectedFileIds`; the metadata stub is tombstoned (not
 * deleted) so historical references resolve to a "removed" label. The
 * raw blob in IndexedDB is best-effort deleted out of band.
 */
export interface FilesSlice {
  files: UploadedFile[]

  addFile: (file: UploadedFile) => void
  removeFile: (fileId: string) => void
  clearFiles: () => void
  setFileExtraction: (
    fileId: string,
    patch: Partial<
      Pick<
        UploadedFile,
        | "extractionStatus"
        | "extractedText"
        | "extractionTruncated"
        | "extractedFullText"
        | "extractedKind"
        | "imageDataUrl"
        | "summary"
        | "keyTopics"
      >
    >
  ) => void
  setFileStorage: (fileId: string, patch: { storagePath?: string | null }) => void
}

export const createFilesSlice: SliceCreator<FilesSlice> = (set) => ({
  files: [],

  addFile: (file) => set((state) => ({ files: [...state.files, file] })),
  removeFile: (fileId) => {
    // Fire-and-forget — IDB delete is best-effort and shouldn't block
    // the UI update. The metadata row stays (tombstoned) so future
    // references — message `attachedFileIds`, notes, citations —
    // resolve to a "removed" label instead of dangling.
    deleteFileLocalData(fileId)
    set((state) => ({
      files: state.files.map((f) =>
        f.id === fileId && !f.deletedAt ? tombstoneFile(f) : f
      ),
      // Atomic cascade: drop every live join row that references this
      // file. The metadata stub remains for historical references but
      // join rows shouldn't claim the file is still attached.
      resources: state.resources.filter((r) => r.fileId !== fileId),
      conversationFiles: state.conversationFiles.filter(
        (cf) => cf.fileId !== fileId
      ),
      conversations: stripSelectionId(state.conversations, "file", fileId),
    }))
  },
  clearFiles: () => {
    void clearLocalBlobs()
    void clearAllFileBlobFields()
    set((state) => ({
      files: state.files.map((f) => (f.deletedAt ? f : tombstoneFile(f))),
      resources: [],
      conversationFiles: [],
      conversations: state.conversations.map((c) =>
        c.selectedFileIds.length > 0 ? { ...c, selectedFileIds: [] } : c
      ),
    }))
  },
  setFileExtraction: (fileId, patch) => {
    // A patch that explicitly clears a blob field (e.g. a re-extraction
    // with no distinct full text) must also clear the IndexedDB copy, or
    // the stale value would be served by the async accessors. New values
    // reach IndexedDB via the `files` subscriber in `use-store.ts`.
    const cleared: FileBlobField[] = FILE_BLOB_FIELDS.filter(
      (k) => k in patch && !patch[k]
    )
    if (cleared.length > 0) void clearFileBlobFields(fileId, cleared)
    set((state) => ({
      files: state.files.map((f) =>
        f.id === fileId ? { ...f, ...patch } : f
      ),
    }))
  },
  setFileStorage: (fileId, patch) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.id === fileId
          ? {
              ...f,
              ...(patch.storagePath !== undefined
                ? { storagePath: patch.storagePath ?? undefined }
                : {}),
            }
          : f
      ),
    })),
})
