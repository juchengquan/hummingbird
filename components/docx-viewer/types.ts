/**
 * Cross-cutting state for the DOCX viewer drawer. Mirrors
 * `usePdfViewer` so any consumer (files tab eye icon, future citation
 * markers, MCP resource links) can call
 * `useDocxViewer.getState().open({ fileId })` without threading props
 * through every render path.
 */

import { create } from "zustand"

export interface DocxViewerTarget {
  fileId: string
}

interface DocxViewerStore {
  target: DocxViewerTarget | null
  open: (target: DocxViewerTarget) => void
  close: () => void
}

export const useDocxViewer = create<DocxViewerStore>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))
