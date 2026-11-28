/**
 * Cross-cutting state for the CSV viewer drawer. Mirrors the other
 * `use*Viewer` stores.
 */

import { create } from "zustand"

export interface CsvViewerTarget {
  fileId: string
}

interface CsvViewerStore {
  target: CsvViewerTarget | null
  open: (target: CsvViewerTarget) => void
  close: () => void
}

export const useCsvViewer = create<CsvViewerStore>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))
