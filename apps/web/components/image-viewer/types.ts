/**
 * Cross-cutting state for the right-side image viewer. Mirrors
 * `usePdfViewer` / `useUrlPreview` so any consumer (attached image
 * thumb, generated-image gallery Expand button, future MCP resource
 * image link) can call `useImageViewer.getState().open(target)`
 * without threading props through every render path.
 *
 * The target carries a list of images so a single open can act as
 * either a single-image preview or a multi-image gallery with prev /
 * next. The `currentIndex` lives in the store (not the target) so
 * Expand → Prev → Next stays driven by one source of truth.
 */

import { create } from "zustand"

/**
 * One image displayed inside the viewer. Context fields are optional —
 * generated images carry `prompt` + `mode`; attached files carry
 * `filename` + `sizeBytes` instead. The viewer renders whichever it
 * has.
 */
export interface ImageViewerItem {
  /** Stable id used as the React key and the download filename stem. */
  id: string
  /** Loadable URL. Can be `data:`, signed cloud URL, or remote http(s). */
  url: string
  /** Required for screen readers + the `<img>` alt attribute. */
  alt: string
  /** File extension Excluding the dot (e.g. "png"). Defaults to "png"
   *  when omitted — used for the download filename + the new-tab
   *  fallback when the URL is a data URI. */
  format?: string
  /** Generated-image context. */
  prompt?: string
  mode?: "t2i" | "i2i"
  /** Attached-file context. */
  filename?: string
  sizeBytes?: number
}

export interface ImageViewerTarget {
  images: ImageViewerItem[]
  /** Optional starting index into `images`. Clamped to `[0, length-1]`
   *  on open. */
  initialIndex?: number
}

interface ImageViewerStore {
  target: ImageViewerTarget | null
  currentIndex: number
  open: (target: ImageViewerTarget) => void
  close: () => void
  setIndex: (i: number) => void
  next: () => void
  prev: () => void
}

export const useImageViewer = create<ImageViewerStore>((set, get) => ({
  target: null,
  currentIndex: 0,
  open: (target) => {
    const len = target.images.length
    const clamped =
      len === 0
        ? 0
        : Math.min(
            Math.max(0, target.initialIndex ?? 0),
            len - 1
          )
    set({ target, currentIndex: clamped })
  },
  close: () => set({ target: null, currentIndex: 0 }),
  setIndex: (i) => {
    const target = get().target
    if (!target) return
    const len = target.images.length
    if (len === 0) return
    const clamped = Math.min(Math.max(0, i), len - 1)
    set({ currentIndex: clamped })
  },
  next: () => {
    const { target, currentIndex } = get()
    if (!target) return
    if (currentIndex < target.images.length - 1) {
      set({ currentIndex: currentIndex + 1 })
    }
  },
  prev: () => {
    const { currentIndex } = get()
    if (currentIndex > 0) set({ currentIndex: currentIndex - 1 })
  },
}))
