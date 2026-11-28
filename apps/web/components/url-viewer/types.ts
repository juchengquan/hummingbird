/**
 * Cross-cutting state for the URL bookmark preview drawer. Mirrors
 * `usePdfViewer` so any consumer (bookmark row, future citation marker,
 * MCP resource link) can call
 * `useUrlPreview.getState().open({ bookmarkId })` without threading
 * props through every render path.
 */

import { create } from "zustand"

export interface UrlPreviewTarget {
  /** Workspace-library bookmark id; the host reads the full row from
   *  the store on open so we don't pass stale content through state. */
  bookmarkId: string
}

interface UrlPreviewStore {
  target: UrlPreviewTarget | null
  open: (target: UrlPreviewTarget) => void
  close: () => void
}

export const useUrlPreview = create<UrlPreviewStore>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))
