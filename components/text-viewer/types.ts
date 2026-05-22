/**
 * Cross-cutting state for the text/json viewer drawer. One store covers
 * both `.txt` and `.json` extensions — the viewer renders them
 * slightly differently (pretty-print + JSON syntax for `.json`,
 * pre-wrap for `.txt`) but the surface, action set, and store are
 * shared.
 */

import { create } from "zustand"

export interface TextViewerTarget {
  fileId: string
}

interface TextViewerStore {
  target: TextViewerTarget | null
  open: (target: TextViewerTarget) => void
  close: () => void
}

export const useTextViewer = create<TextViewerStore>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))
