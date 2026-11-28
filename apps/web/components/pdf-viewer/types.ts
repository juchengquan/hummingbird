/**
 * Cross-cutting state for the PDF viewer dialog so the chat-message
 * component can request "open this PDF on page N" from a citation
 * marker without having to thread props through every render path.
 */

import { create } from "zustand"

export interface PdfViewerTarget {
  fileId: string
  /** 1-indexed page to scroll to on open. */
  page?: number
  /** Optional snippet to highlight on the page. */
  highlight?: string
}

interface PdfViewerStore {
  target: PdfViewerTarget | null
  open: (target: PdfViewerTarget) => void
  close: () => void
}

export const usePdfViewer = create<PdfViewerStore>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))
